import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { activeTabFor, MOBILE_TABS, scopeHrefFor } from '@/lib/mobileTabs'

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

  // A strategy detail page belongs to Strategies alongside the index.
  it('files a strategy detail page under Strategies', () => {
    expect(activeTabFor('/app/NQ/strategies/abc-123')).toBe('strategies')
    expect(activeTabFor('/app/NQ/strategies')).toBe('strategies')
    expect(activeTabFor('/app/strategies')).toBe('strategies')
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
// /app/<symbol>/strategies, which did not exist, so it 404'd on every
// tap. The route exists now, and the sheet is gone - but the thing worth
// asserting is unchanged, so it is asserted against the filesystem
// rather than against a comment that could go stale.
describe('every tab points at a route that exists', () => {
  // App Router: /app/NQ/strategies is served by
  // app/app/[instrument]/strategies/page.js. Map a built path back to the
  // file that must exist for it.
  const pageFileFor = (path) => {
    const parts = path.split('/').filter(Boolean).slice(1) // drop leading "app"
    const dirs = parts.map((p) => (p === 'NQ' ? '[instrument]' : p))
    return resolve(process.cwd(), 'app', 'app', ...dirs, 'page.js')
  }

  it.each(MOBILE_TABS.map((t) => [t.key]))('%s resolves to a real page, with a symbol', (key) => {
    const tab = MOBILE_TABS.find((t) => t.key === key)
    expect(typeof tab.path, `${key} should have a path`).toBe('function')
    const path = tab.path('NQ')
    expect(path).toMatch(/^\/app(\/|$)/)
    expect(existsSync(pageFileFor(path)), `${key} -> ${path} has no page.js`).toBe(true)
  })

  it.each(MOBILE_TABS.map((t) => [t.key]))('%s resolves to a real page, with no symbol', (key) => {
    const tab = MOBILE_TABS.find((t) => t.key === key)
    const path = tab.path(null)
    expect(existsSync(pageFileFor(path)), `${key} -> ${path} has no page.js`).toBe(true)
  })
})

// The invariant that caught a dead tab: Strategies used to fall back to
// /app with no instrument in view, which is exactly where Overview goes.
// Two of five tabs led to one page, so tapping Strategies at scope "All
// instruments" silently showed the Overview - no error, no 404, nothing
// to notice. A set of five destinations has to be five destinations.
describe('no two tabs can resolve to the same URL', () => {
  it.each([['NQ'], [null]])('with symbol %s', (symbol) => {
    // The Log tab has no instrument-less destination of its own - the tab
    // bar renders it as an instrument picker there (see MobileTabBar), so
    // its fallback path is never actually navigated to and is excluded.
    const tabs = MOBILE_TABS.filter((t) => symbol || t.key !== 'new')
    const paths = tabs.map((t) => t.path(symbol))
    expect(new Set(paths).size, `duplicate destinations: ${paths.join(', ')}`).toBe(paths.length)
  })
})

// Scope and section are meant to be independent: changing instrument
// keeps the section you are in. The desktop's InstrumentNav always resets
// to the dashboard instead, which is the one place the app's two
// navigation systems openly contradict each other.
describe('scopeHrefFor', () => {
  it.each([
    ['/app/NQ/log', 'ES', '/app/ES/log'],
    ['/app/NQ/dashboard', 'ES', '/app/ES/dashboard'],
    ['/app/NQ/strategies', 'ES', '/app/ES/strategies'],
    ['/app/log', 'NQ', '/app/NQ/log'],
    ['/app', 'NQ', '/app/NQ/dashboard'],
  ])('%s + %s -> %s', (from, symbol, expected) => {
    expect(scopeHrefFor(from, symbol)).toBe(expected)
  })

  it('carries a section back to its instrument-less form', () => {
    expect(scopeHrefFor('/app/NQ/log', null)).toBe('/app/log')
    expect(scopeHrefFor('/app/NQ/strategies', null)).toBe('/app/strategies')
  })

  // A strategy id belongs to one instrument, so it cannot be carried
  // across - the section can, and resolves to the new instrument's index.
  it('sends strategy detail to the new instrument strategy index', () => {
    expect(scopeHrefFor('/app/NQ/strategies/abc-123', 'ES')).toBe('/app/ES/strategies')
  })

  // Account is not instrument-scoped, so "keep your section" would mean
  // the control visibly does nothing. Picking an instrument there means
  // "go to this instrument".
  it('leaves account for the chosen instrument overview', () => {
    expect(scopeHrefFor('/app/account', 'ES')).toBe('/app/ES/dashboard')
    expect(scopeHrefFor('/app/account', null)).toBe('/app')
  })
})

// Account settings and the all-instruments pages have no instrument in
// view, and the tab bar is the only way off them. Before these paths took
// a null symbol, every symbol-dependent tab there built
// "/app/undefined/dashboard" - a 404, on the screen with no other exit.
describe('the tab paths with no instrument in view', () => {
  it('never builds a path containing undefined', () => {
    for (const tab of MOBILE_TABS) {
      const path = tab.path(null)
      expect(path, `${tab.key} with no symbol`).not.toContain('undefined')
      expect(path).toMatch(/^\/app(\/|$)/)
    }
  })

  it('degrades each tab to its instrument-less equivalent', () => {
    const by = (k) => MOBILE_TABS.find((t) => t.key === k).path(null)
    expect(by('dashboard')).toBe('/app')
    expect(by('log')).toBe('/app/log')
    expect(by('strategies')).toBe('/app/strategies')
    expect(by('account')).toBe('/app/account')
  })
})
