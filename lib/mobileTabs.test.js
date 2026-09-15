import { describe, it, expect } from 'vitest'
import { activeTabFor, MOBILE_TABS } from '@/lib/mobileTabs'

// Which tab lights up for a given path.
//
// Worth testing rather than eyeballing because the failure is silent and
// disorienting: no tab lit reads as "you are nowhere in this app", and
// the WRONG tab lit is worse - it tells the user they are somewhere they
// are not. Neither throws, neither shows up in a build, and both are easy
// to introduce by adding a route.
describe('activeTabFor', () => {
  it.each([
    ['/app/NQ/dashboard', 'dashboard'],
    ['/app/NQ/log', 'log'],
    ['/app/NQ/log/new', 'new'],
    ['/app/MNQ/log/new', 'new'],
    ['/app/account', 'account'],
  ])('%s lights %s', (path, tab) => {
    expect(activeTabFor(path)).toBe(tab)
  })

  // Editing a trade belongs to Trades, not to the Log-a-trade tab. They
  // are the same form, which is exactly why the naive `includes('/log/')`
  // check gets it wrong.
  it('files editing an existing trade under Trades, not under Log', () => {
    expect(activeTabFor('/app/NQ/log/8f2c/edit')).toBe('log')
  })

  // A strategy detail page is reached through the Strategies sheet, so
  // that tab is the one that should read as current.
  it('files a strategy detail page under Strategies', () => {
    expect(activeTabFor('/app/NQ/strategies/abc-123')).toBe('strategies')
  })

  it('returns null rather than guessing for a path outside the tabs', () => {
    expect(activeTabFor('/login')).toBeNull()
    expect(activeTabFor('')).toBeNull()
    expect(activeTabFor(undefined)).toBeNull()
  })

  // The two instrument-less screens are the same destinations one level
  // up, so they light the same tabs rather than leaving none lit - which
  // reads to the user as "you are nowhere in this app".
  it('lights Trades on the all-instruments log and Overview on /app', () => {
    expect(activeTabFor('/app/log')).toBe('log')
    expect(activeTabFor('/app')).toBe('dashboard')
  })
})

// The bug this file was written after: the Strategies tab pointed at
// /app/<symbol>/strategies, which does not exist. The app has only
// strategies/[strategyId], so the tab 404'd on every tap. A link that
// resolves to nothing is the one navigation failure a user cannot work
// around, so the tab definition is asserted to carry no path at all.
describe('the Strategies tab', () => {
  it('opens a sheet rather than linking to a route that does not exist', () => {
    const tab = MOBILE_TABS.find((t) => t.key === 'strategies')
    expect(tab).toBeDefined()
    expect(tab.sheet).toBe(true)
    expect(tab.path).toBeUndefined()
  })

  // Every other tab must resolve to a real path, for the same reason.
  it('gives every non-sheet tab a path that builds', () => {
    for (const tab of MOBILE_TABS.filter((t) => !t.sheet)) {
      expect(typeof tab.path, `${tab.key} should have a path`).toBe('function')
      expect(tab.path('NQ')).toMatch(/^\/app\//)
    }
  })
})

// Account settings and the all-instruments pages have no instrument in
// view, and the tab bar is the only way off them. Before these paths took
// a null symbol, every symbol-dependent tab there built
// "/app/undefined/dashboard" - a 404, on the screen with no other exit.
describe('the tab paths with no instrument in view', () => {
  it('never builds a path containing undefined', () => {
    for (const tab of MOBILE_TABS.filter((t) => !t.sheet)) {
      const path = tab.path(null)
      expect(path, `${tab.key} with no symbol`).not.toContain('undefined')
      expect(path).toMatch(/^\/app(\/|$)/)
    }
  })

  it('degrades each tab to its instrument-less equivalent', () => {
    const by = (k) => MOBILE_TABS.find((t) => t.key === k).path(null)
    expect(by('dashboard')).toBe('/app')
    expect(by('log')).toBe('/app/log')
    expect(by('account')).toBe('/app/account')
  })
})
