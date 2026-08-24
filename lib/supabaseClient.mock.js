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
]
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
]

if (typeof window !== 'undefined') {
  // Lets a Playwright script read/assert against live mock state, e.g.
  // `page.evaluate(() => window.__MOCK_TRADES__)`.
  window.__MOCK_TRADES__ = MOCK_TRADES
}

function tableFor(name) {
  if (name === 'instruments') return MOCK_INSTRUMENTS
  if (name === 'strategies') return MOCK_STRATEGIES
  if (name === 'trades') return MOCK_TRADES
  return []
}
function setTableFor(name, rows) {
  if (name === 'trades') MOCK_TRADES = rows
}

function chain(name, rows) {
  const state = { rows }
  const api = {
    select: () => api,
    eq: (k, v) => { state.rows = state.rows.filter((r) => r[k] === v); return api },
    in: (k, vals) => { state.rows = state.rows.filter((r) => vals.includes(r[k])); return api },
    order: () => api,
    limit: (n) => { state.rows = state.rows.slice(0, n); return api },
    single: async () => {
      if (state.rows.length === 0) return { data: null, error: { code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object' } }
      return { data: state.rows[0], error: null }
    },
    update: (patch) => ({
      eq: async (k, v) => {
        if (typeof window !== 'undefined') window.__lastUpdatePatch__ = patch
        tableFor(name).forEach((r) => { if (r[k] === v) Object.assign(r, patch) })
        return { data: null, error: null }
      },
    }),
    delete: () => ({
      eq: async (k, v) => {
        setTableFor(name, tableFor(name).filter((r) => r[k] !== v))
        return { data: null, error: null }
      },
    }),
    insert: (rowsToInsert) => {
      const inserted = rowsToInsert.map((r) => ({ id: 'new-' + Math.random().toString(36).slice(2), ...r }))
      tableFor(name).push(...inserted)
      return {
        select: () => ({ single: async () => ({ data: inserted[0], error: null }) }),
        then: (resolve) => resolve({ data: null, error: null }),
      }
    },
    then: (resolve) => resolve({ data: state.rows, error: null }),
  }
  return api
}

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
}
