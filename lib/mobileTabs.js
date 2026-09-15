// The mobile tab bar's structure and routing, kept apart from the
// component that renders it.
//
// Two reasons, and the second is the one that matters. It keeps the icons
// (and JSX) out of a module that is otherwise pure - and this repo's test
// runner only handles pure modules, so logic left inside a component is
// logic that cannot be tested at all. The first version of this lived in
// the component and shipped a tab pointing at a route that does not
// exist; a test would have caught that before a browser did.

// Strategies carries no path on purpose. There is no
// /app/<symbol>/strategies route - the app has strategies/[strategyId]
// and nothing else, because on desktop the list is a sidebar dropdown
// rather than a page. Pointing the tab there 404'd on every tap. Adding
// an index route would also have fixed it, but that puts a new URL into
// the desktop app purely to serve a mobile need, and a picker sheet is
// the better phone interaction regardless: one tap to the strategy
// instead of a tap to a list and another out of it.
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
// has no instrument-less form to fall back to, so it goes to /app, which
// is where an instrument gets chosen.
export const MOBILE_TABS = [
  { key: 'dashboard', label: 'Overview', path: (s) => (s ? `/app/${s}/dashboard` : '/app') },
  { key: 'log', label: 'Trades', path: (s) => (s ? `/app/${s}/log` : '/app/log') },
  { key: 'new', label: 'Log', path: (s) => (s ? `/app/${s}/log/new` : '/app'), primary: true },
  { key: 'strategies', label: 'Strategies', sheet: true },
  { key: 'account', label: 'Account', path: () => '/app/account' },
]

// Which tab a path belongs to.
//
// Deliberately not a set of equality checks. /app/NQ/log/new is its own
// tab while /app/NQ/log/<id>/edit belongs to Trades - the same form
// reached two ways - and a strategy detail page belongs to Strategies
// even though the tab that opens it is a sheet. Order matters here: the
// /log/new test has to run before the general /log one, or editing and
// logging both fall into the same bucket.
export function activeTabFor(pathname) {
  if (!pathname) return null
  if (pathname.startsWith('/app/account')) return 'account'
  if (/\/log\/new$/.test(pathname)) return 'new'
  if (/\/strategies(\/|$)/.test(pathname)) return 'strategies'
  // The all-instruments trade log is the Trades tab's instrument-less
  // form, so it lights the same tab. Checked before the per-instrument
  // pattern because /app/log would not match that one anyway, and
  // leaving it out is what made the tab read as "nowhere" there.
  if (pathname === '/app/log') return 'log'
  if (/^\/app\/[^/]+\/log(\/|$)/.test(pathname)) return 'log'
  if (/\/dashboard(\/|$)/.test(pathname)) return 'dashboard'
  // The cross-instrument dashboard is Overview's instrument-less form.
  if (pathname === '/app') return 'dashboard'
  return null
}
