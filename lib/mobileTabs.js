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
export const MOBILE_TABS = [
  { key: 'dashboard', label: 'Overview', path: (s) => `/app/${s}/dashboard` },
  { key: 'log', label: 'Trades', path: (s) => `/app/${s}/log` },
  { key: 'new', label: 'Log', path: (s) => `/app/${s}/log/new`, primary: true },
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
  if (/^\/app\/[^/]+\/log(\/|$)/.test(pathname)) return 'log'
  if (/\/dashboard(\/|$)/.test(pathname)) return 'dashboard'
  return null
}
