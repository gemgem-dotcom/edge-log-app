// In-memory stand-in for the real Supabase client, swapped in for local
// dev/testing via next.config.js's webpack alias whenever
// NEXT_PUBLIC_USE_MOCK_DB=true (see `npm run dev:mock`). Never imported by
// any production code path - the alias is the only thing that ever pulls
// this file in, and it's gated on an env var nobody sets in Vercel/CI, so
// this never ships and never touches the real database.
//
// Existing to save re-writing the same mock client from scratch every time
// a UI change needs verifying against realistic data (multi-exit trades,
// screenshots, tags, discipline issues) without touching production rows -
// see CLAUDE.md's "Vercel previews use the production database" warning
// for why that matters.
//
// Trades here cover both the single-exit and multi-exit shapes so most UI
// work can verify against this out of the box; add more MOCK_TRADES rows
// (or edit these) for whatever a specific change needs to exercise. Data
// only lives in memory for the life of the dev server process - nothing
// here persists or leaks anywhere real.

const MOCK_USER = { id: 'u1', email: 'trader@example.com', user_metadata: { full_name: 'Trader', timezone: '-5' } }
const MOCK_INSTRUMENTS = [
  { id: 'i1', user_id: 'u1', symbol: 'NQ', data_symbol: 'NQ', archived: false, created_at: '2026-01-01' },
]
const MOCK_STRATEGIES = [
  { id: 's1', instrument_id: 'i1', name: 'Opening Range Break', archived: false, created_at: '2026-01-01' },
  { id: 's2', instrument_id: 'i1', name: 'Fade Reversal', archived: false, created_at: '2026-01-01' },
]
// t5-t24 add the session/day-of-week/discipline-tag/second-strategy variety
// the AI insights feature's breakdowns need real data to describe - t1-t4
// above are left untouched since other UI work verifies against their
// exact values. Sessions are set directly
// (lib/marketHours.js's sessionFor labels) rather than derived, matching
// how a real trade's `session` column is written once at save time.
let MOCK_TRADES = [
  {
    id: 't1', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long',
    trade_date: '2026-01-15', trade_time: '08:00:00', exit_time: '08:45:00',
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: '21010', contracts: 2, r_multiple: 1.1666666666666667, pnl: 400, tags: ['a-tag'],
    reviewed_no_issues: true, discipline_tags: [], reasoning: 'Sample multi-exit trade for testing.',
    additional_exits: [
      { exit_time: '08:45:00', exit_price: '21015', contracts: 1 },
    ],
    screenshot_urls: [],
  },
  {
    id: 't2', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'short',
    trade_date: '2026-01-16', trade_time: '09:00:00', exit_time: '09:20:00',
    entry: '21000', stop: '21010', target: '20980', stop_distance: '10', target_distance: '20',
    exit_price: '20992', exit_points: '8', contracts: 3, r_multiple: 0.8, pnl: 480, tags: [],
    reviewed_no_issues: false, discipline_tags: ['Went against bias'], reasoning: 'Sample single-exit trade for testing.',
    additional_exits: [],
    screenshot_urls: [],
  },
  {
    id: 't3', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long',
    trade_date: '2026-01-17', trade_time: '08:00:00', exit_time: '08:15:00',
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: '20990', contracts: 1, r_multiple: -1, pnl: -200, tags: [],
    reviewed_no_issues: true, discipline_tags: [], reasoning: 'Sample losing trade for testing.',
    additional_exits: [],
    screenshot_urls: [],
  },
  {
    id: 't4', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long',
    trade_date: '2026-01-18', trade_time: '08:00:00', exit_time: '08:10:00',
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: '21000', contracts: 1, r_multiple: 0, pnl: 0, tags: [],
    reviewed_no_issues: true, discipline_tags: [], reasoning: 'Sample breakeven trade for testing.',
    additional_exits: [],
    screenshot_urls: [],
  },
  {
    id: 't5', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long', session: 'London session',
    trade_date: '2026-01-19', trade_time: '03:30:00', exit_time: '04:15:00',
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: '21012', contracts: 2, r_multiple: 1.2, pnl: 240, tags: [],
    reviewed_no_issues: true, discipline_tags: [], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't6', user_id: 'u1', instrument_id: 'i1', strategy_id: 's2', direction: 'short', session: 'New York AM',
    trade_date: '2026-01-19', trade_time: '10:00:00', exit_time: '10:30:00',
    entry: '21000', stop: '21010', target: '20980', stop_distance: '10', target_distance: '20',
    exit_price: '21008', contracts: 2, r_multiple: -0.8, pnl: -160, tags: [],
    reviewed_no_issues: false, discipline_tags: ['Oversized'], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't7', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long', session: 'New York AM',
    trade_date: '2026-01-20', trade_time: '10:15:00', exit_time: '10:50:00',
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: '21009', contracts: 2, r_multiple: 0.9, pnl: 180, tags: [],
    reviewed_no_issues: true, discipline_tags: [], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't8', user_id: 'u1', instrument_id: 'i1', strategy_id: 's2', direction: 'short', session: 'Asian session',
    trade_date: '2026-01-20', trade_time: '01:00:00', exit_time: '01:40:00',
    entry: '21000', stop: '21010', target: '20980', stop_distance: '10', target_distance: '20',
    exit_price: '21010', contracts: 2, r_multiple: -1, pnl: -200, tags: [],
    reviewed_no_issues: false, discipline_tags: ['Chased price / late entry'], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't9', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long', session: 'US pre-market',
    trade_date: '2026-01-21', trade_time: '08:45:00', exit_time: '09:20:00',
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: '21015', contracts: 2, r_multiple: 1.5, pnl: 300, tags: [],
    reviewed_no_issues: true, discipline_tags: [], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't10', user_id: 'u1', instrument_id: 'i1', strategy_id: 's2', direction: 'short', session: 'New York PM',
    trade_date: '2026-01-21', trade_time: '13:45:00', exit_time: '14:10:00',
    entry: '21000', stop: '21010', target: '20980', stop_distance: '10', target_distance: '20',
    exit_price: '20994', contracts: 2, r_multiple: 0.6, pnl: 120, tags: [],
    reviewed_no_issues: false, discipline_tags: [], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't11', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long', session: 'London session',
    trade_date: '2026-01-22', trade_time: '03:30:00', exit_time: '04:00:00',
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: '20987', contracts: 2, r_multiple: -1.3, pnl: -260, tags: [],
    reviewed_no_issues: false, discipline_tags: ['Oversized'], reasoning: 'Mock fixture for Phase 3 edge insights.',
    mfe_points: 25, mae_points: 14, drawdown_seconds: 900, market_data_status: 'complete',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't12', user_id: 'u1', instrument_id: 'i1', strategy_id: 's2', direction: 'short', session: 'Midday lull',
    trade_date: '2026-01-22', trade_time: '12:00:00', exit_time: '12:30:00',
    entry: '21000', stop: '21010', target: '20980', stop_distance: '10', target_distance: '20',
    exit_price: '20989', contracts: 2, r_multiple: 1.1, pnl: 220, tags: [],
    reviewed_no_issues: true, discipline_tags: [], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't13', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long', session: 'New York AM',
    trade_date: '2026-01-23', trade_time: '10:00:00', exit_time: '10:45:00',
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: '21020', contracts: 2, r_multiple: 2.0, pnl: 400, tags: [],
    reviewed_no_issues: true, discipline_tags: [], reasoning: 'Mock fixture for Phase 3 edge insights.',
    mfe_points: 30, mae_points: 5, drawdown_seconds: 300, market_data_status: 'complete',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't14', user_id: 'u1', instrument_id: 'i1', strategy_id: 's2', direction: 'short', session: 'New York AM',
    trade_date: '2026-01-23', trade_time: '10:30:00', exit_time: '11:00:00',
    entry: '21000', stop: '21010', target: '20980', stop_distance: '10', target_distance: '20',
    exit_price: '21007', contracts: 2, r_multiple: -0.7, pnl: -140, tags: [],
    reviewed_no_issues: false, discipline_tags: ['Revenge trade'], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't15', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long', session: 'Asian session',
    trade_date: '2026-01-26', trade_time: '01:00:00', exit_time: '01:35:00',
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: '21005', contracts: 2, r_multiple: 0.5, pnl: 100, tags: [],
    reviewed_no_issues: true, discipline_tags: [], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't16', user_id: 'u1', instrument_id: 'i1', strategy_id: 's2', direction: 'short', session: 'London session',
    trade_date: '2026-01-26', trade_time: '03:30:00', exit_time: '04:05:00',
    entry: '21000', stop: '21010', target: '20980', stop_distance: '10', target_distance: '20',
    exit_price: '21012', contracts: 2, r_multiple: -1.2, pnl: -240, tags: [],
    reviewed_no_issues: false, discipline_tags: ['Oversized'], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't17', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long', session: 'US pre-market',
    trade_date: '2026-01-27', trade_time: '08:45:00', exit_time: '09:15:00',
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: '21010', contracts: 2, r_multiple: 1.0, pnl: 200, tags: [],
    reviewed_no_issues: true, discipline_tags: [], reasoning: 'Mock fixture for Phase 3 edge insights.',
    mfe_points: 18, mae_points: 9, drawdown_seconds: 600, market_data_status: 'complete',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't18', user_id: 'u1', instrument_id: 'i1', strategy_id: 's2', direction: 'short', session: 'New York PM',
    trade_date: '2026-01-27', trade_time: '13:45:00', exit_time: '14:15:00',
    entry: '21000', stop: '21010', target: '20980', stop_distance: '10', target_distance: '20',
    exit_price: '20992', contracts: 2, r_multiple: 0.8, pnl: 160, tags: [],
    reviewed_no_issues: false, discipline_tags: [], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't19', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long', session: 'New York AM',
    trade_date: '2026-01-28', trade_time: '10:00:00', exit_time: '10:40:00',
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: '20991', contracts: 2, r_multiple: -0.9, pnl: -180, tags: [],
    reviewed_no_issues: false, discipline_tags: ['Held loser too long'], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't20', user_id: 'u1', instrument_id: 'i1', strategy_id: 's2', direction: 'short', session: 'Midday lull',
    trade_date: '2026-01-28', trade_time: '12:00:00', exit_time: '12:35:00',
    entry: '21000', stop: '21010', target: '20980', stop_distance: '10', target_distance: '20',
    exit_price: '20987', contracts: 2, r_multiple: 1.3, pnl: 260, tags: [],
    reviewed_no_issues: true, discipline_tags: [], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't21', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long', session: 'London session',
    trade_date: '2026-01-29', trade_time: '03:30:00', exit_time: '04:10:00',
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: '21011', contracts: 2, r_multiple: 1.1, pnl: 220, tags: [],
    reviewed_no_issues: true, discipline_tags: [], reasoning: 'Mock fixture for Phase 3 edge insights.',
    mfe_points: 22, mae_points: 11, drawdown_seconds: 450, market_data_status: 'complete',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't22', user_id: 'u1', instrument_id: 'i1', strategy_id: 's2', direction: 'short', session: 'Asian session',
    trade_date: '2026-01-29', trade_time: '01:00:00', exit_time: '01:45:00',
    entry: '21000', stop: '21010', target: '20980', stop_distance: '10', target_distance: '20',
    exit_price: '21015', contracts: 2, r_multiple: -1.5, pnl: -300, tags: [],
    reviewed_no_issues: false, discipline_tags: ['Oversized'], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't23', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long', session: 'New York AM',
    trade_date: '2026-01-30', trade_time: '10:00:00', exit_time: '10:30:00',
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: '21007', contracts: 2, r_multiple: 0.7, pnl: 140, tags: [],
    reviewed_no_issues: true, discipline_tags: [], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't24', user_id: 'u1', instrument_id: 'i1', strategy_id: 's2', direction: 'short', session: 'New York AM',
    trade_date: '2026-01-30', trade_time: '10:30:00', exit_time: '11:05:00',
    entry: '21000', stop: '21010', target: '20980', stop_distance: '10', target_distance: '20',
    exit_price: '21010', contracts: 2, r_multiple: -1.0, pnl: -200, tags: [],
    reviewed_no_issues: false, discipline_tags: ['Chased price / late entry'], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't25', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long', session: 'London session',
    trade_date: '2026-02-02', trade_time: '03:30:00', exit_time: '04:05:00',
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: '20989', contracts: 2, r_multiple: -1.1, pnl: -220, tags: [],
    reviewed_no_issues: false, discipline_tags: ['Oversized'], reasoning: 'Mock fixture for Phase 3 edge insights.',
    additional_exits: [], screenshot_urls: [],
  },
  // t26-t28 exist purely to push the trade log's mock NQ trade count past
  // 25 (TradeLogTable's pageSize) - real server-side pagination
  // (lib/tradeQuery.js) has nothing to page through otherwise. Also carry
  // a distinct tag ("Backtested") to exercise the tag filter dropdown.
  {
    id: 't26', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long', session: 'New York AM',
    trade_date: '2026-02-03', trade_time: '09:35:00', exit_time: '10:05:00',
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: '21020', contracts: 2, r_multiple: 2.0, pnl: 400, tags: ['Backtested'],
    reviewed_no_issues: true, discipline_tags: [], reasoning: 'Mock fixture for pagination.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't27', user_id: 'u1', instrument_id: 'i1', strategy_id: 's2', direction: 'short', session: 'Midday lull',
    trade_date: '2026-02-04', trade_time: '12:35:00', exit_time: '13:05:00',
    entry: '21000', stop: '21010', target: '20980', stop_distance: '10', target_distance: '20',
    exit_price: '21010', contracts: 2, r_multiple: -1.0, pnl: -200, tags: ['Backtested'],
    reviewed_no_issues: true, discipline_tags: [], reasoning: 'Mock fixture for pagination.',
    additional_exits: [], screenshot_urls: [],
  },
  {
    id: 't28', user_id: 'u1', instrument_id: 'i1', strategy_id: 's1', direction: 'long', session: 'New York PM',
    trade_date: '2026-02-05', trade_time: '14:35:00', exit_time: null,
    entry: '21000', stop: '20990', target: '21020', stop_distance: '10', target_distance: '20',
    exit_price: null, contracts: 2, r_multiple: null, pnl: null, tags: [],
    reviewed_no_issues: false, discipline_tags: [], reasoning: 'Mock fixture for pagination (open trade).',
    additional_exits: [], screenshot_urls: [],
  },
]

// Empty by default - populated only once a panel actually triggers a
// (mocked, in dev) generation, same as the real table starts empty for a
// brand-new account.
let MOCK_EDGE_INSIGHTS = []

if (typeof window !== 'undefined') {
  // Lets a Playwright script read/assert against live mock state, e.g.
  // `page.evaluate(() => window.__MOCK_TRADES__)`.
  window.__MOCK_TRADES__ = MOCK_TRADES
  window.__MOCK_EDGE_INSIGHTS__ = MOCK_EDGE_INSIGHTS
}

// Tables whose real schema.sql definition has an `archived` column - see
// insert()'s own comment below for why this matters.
const ARCHIVABLE_TABLES = new Set(['instruments', 'strategies'])

function tableFor(name) {
  if (name === 'instruments') return MOCK_INSTRUMENTS
  if (name === 'strategies') return MOCK_STRATEGIES
  if (name === 'trades') return MOCK_TRADES
  if (name === 'edge_insights') return MOCK_EDGE_INSIGHTS
  return []
}
function setTableFor(name, rows) {
  if (name === 'trades') MOCK_TRADES = rows
  if (name === 'edge_insights') MOCK_EDGE_INSIGHTS = rows
}

function chain(name, rows) {
  const state = { rows }
  // Composite sort over every .order() call so far, primary key first -
  // real PostgREST resolves .order('a').order('b') as ORDER BY a, b, not
  // b overriding a. Nulls sort first ascending / last descending, matching
  // Postgres's own default NULLS FIRST-on-ASC behavior closely enough for
  // this app's own queries (none of which sort a nullable column).
  function sortedRows() {
    if (!state.orderSpecs || state.orderSpecs.length === 0) return state.rows
    return [...state.rows].sort((a, b) => {
      for (const { col, ascending } of state.orderSpecs) {
        const av = a[col]
        const bv = b[col]
        if (av === bv) continue
        if (av === null || av === undefined) return ascending ? -1 : 1
        if (bv === null || bv === undefined) return ascending ? 1 : -1
        const cmp = av < bv ? -1 : 1
        return ascending ? cmp : -cmp
      }
      return 0
    })
  }
  const api = {
    // count captured here (not read until the terminal then() below) so a
    // later .range() can snapshot "how many rows matched every filter
    // applied so far" before slicing them down to one page - matching real
    // PostgREST's count:'exact', which reflects the full filtered result
    // set regardless of the range requested on top of it.
    select: (_cols, opts) => { state.wantCount = opts?.count === 'exact'; return api },
    eq: (k, v) => { state.rows = state.rows.filter((r) => r[k] === v); return api },
    // day_of_week is a generated column in real Postgres (schema.sql),
    // derived from trade_date - MOCK_TRADES rows don't carry one, so this
    // computes the same value on the fly (getDay() is 0=Sunday..6=Saturday,
    // matching Postgres's extract(dow from ...) exactly) rather than
    // needing every mock row hand-populated with it.
    in: (k, vals) => {
      state.rows = state.rows.filter((r) => {
        const v = k === 'day_of_week' && r.day_of_week === undefined
          ? new Date(r.trade_date + 'T00:00:00').getDay()
          : r[k]
        return vals.includes(v)
      })
      return api
    },
    gt: (k, v) => { state.rows = state.rows.filter((r) => r[k] != null && r[k] > v); return api },
    lt: (k, v) => { state.rows = state.rows.filter((r) => r[k] != null && r[k] < v); return api },
    is: (k, v) => { state.rows = state.rows.filter((r) => (v === null ? (r[k] === null || r[k] === undefined) : r[k] === v)); return api },
    overlaps: (k, vals) => { state.rows = state.rows.filter((r) => (r[k] || []).some((x) => vals.includes(x))); return api },
    // Narrow, deliberately not a real PostgREST filter-string parser - only
    // handles the two shapes this app's own code actually sends
    // (lib/tradeRegimes.js's 'col.is.null,col2.is.null', and
    // lib/tradeQuery.js's 'col.in.(id1,id2)'): a comma-joined list of
    // conditions, matched as a real OR (a row passes if ANY condition
    // matches). Splits on commas outside parens only, so an .in.(a,b) value
    // isn't mistaken for two separate conditions. Extend this the same
    // narrow way if a future .or() call needs a different operator, rather
    // than building out a general-purpose filter grammar nothing else needs.
    or: (filterString) => {
      const conditions = []
      let depth = 0, current = ''
      for (const ch of filterString) {
        if (ch === '(') depth++
        if (ch === ')') depth--
        if (ch === ',' && depth === 0) { conditions.push(current); current = '' } else { current += ch }
      }
      if (current) conditions.push(current)
      state.rows = state.rows.filter((r) => conditions.some((c) => {
        const [col, op, val] = c.split('.')
        if (op === 'is' && val === 'null') return r[col] === null || r[col] === undefined
        if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').filter(Boolean).includes(r[col])
        return false
      }))
      return api
    },
    // Deferred rather than applied immediately - the real chain calls this
    // once per sort key (e.g. .order('trade_date',...).order('trade_time',...),
    // primary key first), so sorting can't happen until every key is known.
    // Applied lazily by sortedRows() below, at whichever terminal method
    // actually reads the rows.
    order: (col, opts) => {
      state.orderSpecs = state.orderSpecs || []
      state.orderSpecs.push({ col, ascending: opts?.ascending !== false })
      return api
    },
    limit: (n) => { state.rows = sortedRows().slice(0, n); return api },
    // Snapshots the pre-slice count (see select() above) before narrowing
    // state.rows down to one page - `to` is inclusive, matching real
    // PostgREST's own .range() semantics.
    range: (from, to) => {
      const sorted = sortedRows()
      state.count = sorted.length
      state.rows = sorted.slice(from, to + 1)
      return api
    },
    single: async () => {
      const rows = sortedRows()
      if (rows.length === 0) return { data: null, error: { code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object' } }
      return { data: rows[0], error: null }
    },
    // Same as single() but zero rows is a plain { data: null }, not an
    // error - matches real PostgREST's own maybeSingle semantics.
    maybeSingle: async () => ({ data: sortedRows()[0] ?? null, error: null }),
    // eq() itself is both awaitable (bare `.update().eq()`, the common case -
    // real PostgREST returns { data: null } here since nothing asked for the
    // row back) and chainable into .select() (real callers: instruments.js's
    // restore flow does .select().single(), SignInHistorySection.js's rename
    // does a bare .select() to confirm RLS actually matched a row) - mirrors
    // insert()'s same then()+select() shape below.
    update: (patch) => ({
      eq: (k, v) => {
        if (typeof window !== 'undefined') window.__lastUpdatePatch__ = patch
        const updated = []
        tableFor(name).forEach((r) => { if (r[k] === v) { Object.assign(r, patch); updated.push(r) } })
        return {
          select: () => ({
            single: async () => (updated.length === 0
              ? { data: null, error: { code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object' } }
              : { data: updated[0], error: null }),
            then: (resolve) => resolve({ data: updated, error: null }),
          }),
          then: (resolve) => resolve({ data: null, error: null }),
        }
      },
    }),
    delete: () => ({
      eq: async (k, v) => {
        setTableFor(name, tableFor(name).filter((r) => r[k] !== v))
        return { data: null, error: null }
      },
    }),
    // `archived` defaults to false in schema.sql, but only for the tables
    // that actually have that column (instruments, strategies) - applied
    // here too, since a caller that omits it (the normal case; only
    // restore/toggle flows set it explicitly) would otherwise get
    // `undefined` on the mock row, which fails any later
    // `.eq('archived', false)` read even though the same insert against
    // the real database would read back as archived=false. Scoped to just
    // those two tables so an inserted mock trade (no `archived` column in
    // the real schema) doesn't end up carrying a field a real Postgres row
    // never would.
    insert: (rowsToInsert) => {
      const archivedDefault = ARCHIVABLE_TABLES.has(name) ? { archived: false } : {}
      const inserted = rowsToInsert.map((r) => ({ id: 'new-' + Math.random().toString(36).slice(2), ...archivedDefault, ...r }))
      tableFor(name).push(...inserted)
      return {
        select: () => ({ single: async () => ({ data: inserted[0], error: null }) }),
        then: (resolve) => resolve({ data: null, error: null }),
      }
    },
    // Mirrors Postgres upsert-on-conflict: for each row, find an existing
    // one matching every column named in onConflict and merge into it in
    // place, otherwise push a freshly-inserted one - mutates the table's
    // own array rather than reassigning it, same as update()/insert()
    // above, so a `window.__MOCK_*__` reference taken at module load stays
    // valid after this runs.
    upsert: (rowsToUpsert, options) => {
      const conflictCols = (options?.onConflict || '').split(',').map((s) => s.trim()).filter(Boolean)
      const table = tableFor(name)
      for (const row of rowsToUpsert) {
        const match = conflictCols.length > 0
          ? table.find((r) => conflictCols.every((c) => r[c] === row[c]))
          : null
        if (match) {
          Object.assign(match, row)
        } else {
          table.push({ id: 'new-' + Math.random().toString(36).slice(2), created_at: new Date().toISOString(), ...row })
        }
      }
      return { then: (resolve) => resolve({ data: null, error: null }) }
    },
    // count only set when select(..., { count: 'exact' }) actually asked
    // for it - state.count comes from range() above; a query with no
    // range() call (e.g. a plain unpaged select) falls back to the final
    // row count, matching what real PostgREST would return for a
    // count:'exact' request with no .range() narrowing it further. Sorted
    // once and reused for both data and the count fallback, rather than
    // resorting the same rows twice.
    then: (resolve) => {
      const rows = sortedRows()
      resolve({ data: rows, error: null, count: state.wantCount ? (state.count ?? rows.length) : undefined })
    },
  }
  return api
}

// Fake signed URL - a tiny inline SVG data URI rather than a broken image
// icon, so a screenshot-bearing mock trade actually renders something
// visible in a manual/Playwright check of lib/screenshots.js's
// getScreenshotUrls plumbing (upload path, resolve-on-render, per-row
// lazy resolution) without needing a real private bucket.
const MOCK_SIGNED_URL = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#334"/></svg>'
)

export const supabase = {
  auth: {
    getUser: async () => ({ data: { user: MOCK_USER }, error: null }),
    getSession: async () => ({ data: { session: { user: MOCK_USER } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    mfa: { listFactors: async () => ({ data: { totp: [] }, error: null }) },
    updateUser: async ({ data }) => { Object.assign(MOCK_USER.user_metadata, data); return { data: { user: MOCK_USER }, error: null } },
  },
  from(name) {
    return chain(name, tableFor(name).slice())
  },
  storage: {
    from: () => ({
      upload: async (path) => ({ data: { path }, error: null }),
      createSignedUrl: async () => ({ data: { signedUrl: MOCK_SIGNED_URL }, error: null }),
      createSignedUrls: async (paths) => ({
        data: paths.map((path) => ({ path, signedUrl: MOCK_SIGNED_URL, error: null })),
        error: null,
      }),
    }),
  },
}
