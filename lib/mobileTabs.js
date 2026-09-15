// The mobile tab bar's structure and routing, kept apart from the
// component that renders it.
//
// Two reasons, and the second is the one that matters. It keeps the icons
// (and JSX) out of a module that is otherwise pure - and this repo's test
// runner only handles pure modules, so logic left inside a component is
// logic that cannot be tested at all. The first version of this lived in
// the component and shipped a tab pointing at a route that does not
// exist; a test would have caught that before a browser did.

// Two of the app's screens have no instrument in view at all - the
// cross-instrument dashboard (/app) and the all-instruments trade log
// (/app/log), plus account settings - and the tab bar has to work there
// too, because it is the only way back. Without this every symbol-
// dependent tab built "/app/undefined/dashboard".
//
// So each path takes a possibly-null symbol and degrades to the
// instrument-less equivalent rather than to a broken URL. Overview falls
// back to the cross-instrument dashboard, Trades to the all-instruments
// log; both are real pages that do the same job one level up. Log-a-trade
// and Strategies have no instrument-less form to fall back to, so they go
// to /app, which is where an instrument gets chosen.
export const MOBILE_TABS = [
  { key: 'dashboard', label: 'Overview', path: (s) => (s ? `/app/${s}/dashboard` : '/app') },
  { key: 'log', label: 'Trades', path: (s) => (s ? `/app/${s}/log` : '/app/log') },
  { key: 'new', label: 'Log', path: (s) => (s ? `/app/${s}/log/new` : '/app') },
  // Strategies is a real page now. It used to carry no path at all and
  // open a bottom sheet instead, because /app/<symbol>/strategies did not
  // exist - the app had strategies/[strategyId] and nothing else, so
  // pointing the tab at an index 404'd on every tap, and a sheet was the
  // cheap fix. Creating the route was always the other option, and it is
  // the better one: a sheet was the only tab that was not a destination,
  // strategy detail had no way back to a list, and the same list was
  // being rendered three separate ways. See
  // app/app/[instrument]/strategies/page.js.
  { key: 'strategies', label: 'Strategies', path: (s) => (s ? `/app/${s}/strategies` : '/app/strategies') },
  { key: 'account', label: 'Account', path: () => '/app/account' },
]

// Which tab a path belongs to.
//
// Deliberately not a set of equality checks. /app/NQ/log/new is its own
// tab while /app/NQ/log/<id>/edit belongs to Trades - the same form
// reached two ways - and a strategy detail page belongs to Strategies
// alongside the index. Order matters here: the /log/new test has to run
// before the general /log one, or editing and logging both fall into the
// same bucket.
export function activeTabFor(pathname) {
  if (!pathname) return null
  if (pathname.startsWith('/app/account')) return 'account'
  if (/\/log\/new$/.test(pathname)) return 'new'
  if (/\/strategies(\/|$)/.test(pathname)) return 'strategies'
  // The all-instruments trade log is the Trades tab's instrument-less
  // form, so it lights the same tab. Checked before the per-instrument
  // pattern because /app/log would not match that one anyway, and
  // leaving it out is what made the tab read as "nowhere" there.
  if (pathname === '/app/strategies') return 'strategies'
  if (pathname === '/app/log') return 'log'
  if (/^\/app\/[^/]+\/log(\/|$)/.test(pathname)) return 'log'
  if (/\/dashboard(\/|$)/.test(pathname)) return 'dashboard'
  // The cross-instrument dashboard is Overview's instrument-less form.
  if (pathname === '/app') return 'dashboard'
  return null
}

// Where changing SCOPE should land you, given where you are now.
//
// This is the inverse of activeTabFor, and it exists because scope and
// section are meant to be independent: picking a different instrument
// should keep you in the section you were already in. The desktop's
// InstrumentNav always sends you to that instrument's dashboard instead,
// which is the one place the app's two navigation systems openly
// contradict each other - the tab bar preserves your section across
// instruments while the pill row resets it.
//
// A pathname the tab bar does not recognise (a strategy detail page has a
// section, but no per-instrument equivalent to carry across - strategy
// ids belong to one instrument) falls back to that instrument's Overview,
// which is the section-less answer rather than a broken URL.
export function scopeHrefFor(pathname, symbol) {
  const section = activeTabFor(pathname)
  // Account is the one section that is not scoped to an instrument, so
  // "keep your section" would mean staying exactly where you are - a
  // control that visibly does nothing. Picking an instrument there means
  // "go to this instrument", so it lands on that instrument's Overview.
  if (section === 'account') return symbol ? `/app/${symbol}/dashboard` : '/app'
  // Strategy DETAIL is 'strategies' too, but its id is meaningless under
  // another instrument, so it resolves to the new instrument's strategy
  // INDEX - which is what the tab's own path already returns.
  const tab = MOBILE_TABS.find((t) => t.key === section)
  if (!tab) return symbol ? `/app/${symbol}/dashboard` : '/app'
  return tab.path(symbol)
}
