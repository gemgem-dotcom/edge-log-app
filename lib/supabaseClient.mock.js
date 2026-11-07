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

// Lets a verification run set the tutorial's starting state from the URL
// instead of hand-editing MOCK_USER and reverting it afterward - e.g.
// http://localhost:PORT/app/NQ/dashboard?mockTutorialStatus=active&mockTutorialStep=2
// spotlights the "Log new trade" button on load. Read once at module load,
// so it sticks for as long as this browser tab's JS keeps running -
// through in-app client-side navigations even once the query string is no
// longer in the address bar, but not through an actual page reload, which
// re-evaluates this module from scratch and needs the query string again.
if (typeof window !== 'undefined') {
  const mockParams = new URLSearchParams(window.location.search)
  if (mockParams.has('mockTutorialStatus')) MOCK_USER.user_metadata.tutorial_status = mockParams.get('mockTutorialStatus')
  if (mockParams.has('mockTutorialStep')) MOCK_USER.user_metadata.tutorial_step = Number(mockParams.get('mockTutorialStep'))
}
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
    reviewed_no_issues: true, discipline_tags: ['Moved stop'], reasoning: 'Mock fixture for pagination.',
    additional_exits: [], screenshot_urls: [],
    // The excursion fields, on exactly one row, and deliberately on a
    // RECENT one so it lands on the first page of the trade log. Every
    // other trade here leaves them unset, which is the "never attempted"
    // path - so both branches of excursionCell (a real figure, and the
    // status message that stands in for one) are reachable in mock mode.
    // Without a row like this, MFE / MAE / time in drawdown could only
    // ever be verified as an em-dash, which is exactly how the mobile row
    // managed to omit all three without anyone noticing.
    market_data_status: 'complete',
    mfe_points: 14.25, mae_points: -3.5, drawdown_seconds: 420,
    trade_time_unverified: true,
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

// econ_release_detail / econ_release_revision, as
// scripts/fetch-econ-release-detail.js stores them.
//
// THE VALUES ARE THE REAL ONES api.bls.gov RETURNED on 2026-10-28, not
// round numbers. They have to be: lib/econStructure.mjs picks which
// argument the CPI line makes from whether OER ran hotter or cooler than
// shelter overall, and a fixture that invented the rates would exercise a
// branch the live data does not take. On these figures shelter runs
// +0.39% and OER +0.35% - OER is the COOLER of the two, so the line takes
// its damping branch.
//
// Index LEVELS across these two series are not comparable (different
// base periods); only the rates are. Stating that here because reading
// 445 against 431 as "OER is hotter" is exactly the mistake these rows
// invite.
const MOCK_ECON_RELEASE_DETAIL = [
  { series_id: 'CUUR0000SA0', year: '2026', period: 'M09', period_name: 'September', value: 336.940, footnote_codes: [] },
  { series_id: 'CUUR0000SA0', year: '2026', period: 'M08', period_name: 'August', value: 334.980, footnote_codes: [] },
  { series_id: 'CUSR0000SAH1', year: '2026', period: 'M09', period_name: 'September', value: 431.908, footnote_codes: [] },
  { series_id: 'CUSR0000SAH1', year: '2026', period: 'M08', period_name: 'August', value: 430.227, footnote_codes: [] },
  { series_id: 'CUSR0000SEHC', year: '2026', period: 'M09', period_name: 'September', value: 445.265, footnote_codes: [] },
  { series_id: 'CUSR0000SEHC', year: '2026', period: 'M08', period_name: 'August', value: 443.713, footnote_codes: [] },
  // BLS's own preliminary flag, which is the reason the payrolls series is
  // fetched at all.
  { series_id: 'CES0000000001', year: '2026', period: 'M09', period_name: 'September', value: 159044, footnote_codes: ['P'] },
  { series_id: 'CES0000000001', year: '2026', period: 'M08', period_name: 'August', value: 159015, footnote_codes: ['P'] },
]

// One recorded revision, so the payrolls branch's revision clause has
// something to render in dev. Payrolls only - see the query's own note on
// why a CPI restatement must not be printed as a payrolls revision.
const MOCK_ECON_RELEASE_REVISION = [
  {
    id: 'rev-1', series_id: 'CES0000000001', year: '2026', period: 'M08',
    period_name: 'August', value_from: 159150, value_to: 159015,
    detected_at: new Date().toISOString(),
  },
]

// A week of economic_events rows, shaped exactly like what
// scripts/fetch-economic-calendar.js stores. Built relative to whatever
// "now" is rather than hardcoded to fixed dates, because
// EconomicCalendarCard opens on the current week - pinned dates would mean
// an empty card on every day except the week they were written.
//
// Deliberately spread across impacts, event types and currencies: the
// filter panel has three independent sections, and a fixture that was all
// high-impact USD growth releases couldn't exercise any of them.
const MOCK_ECONOMIC_EVENTS = (() => {
  const sunday = new Date()
  sunday.setDate(sunday.getDate() - sunday.getDay())
  sunday.setHours(0, 0, 0, 0)
  // dayOffset is 0=Sunday..6=Saturday within the current week; hh/mm are
  // local wall-clock, which is what the card renders.
  const at = (dayOffset, hh, mm) => {
    const d = new Date(sunday)
    d.setDate(d.getDate() + dayOffset)
    d.setHours(hh, mm, 0, 0)
    return d.toISOString()
  }
  // The calendar day an offset lands on, in the viewer's own zone.
  const dayOf = (dayOffset) => {
    const d = new Date(sunday)
    d.setDate(d.getDate() + dayOffset)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  // An all-day row is NOT stored at the viewer's midnight. It is anchored
  // to midnight in FF's own display zone, which FF picks from the client
  // IP and which is US Mountain for the runners that write these rows - so
  // 06:00Z, and the day lives in the key rather than in the timestamp.
  //
  // This fixture used to build all-day rows at LOCAL midnight, which made
  // the mock agree with the viewer by construction and hid a real bug:
  // every viewer west of FF saw those rows a day early, and a single-day
  // range dropped them entirely because their instant fell outside the
  // window bounding the viewer's own day.
  const ffAllDayAt = (dayOffset) => `${dayOf(dayOffset)}T06:00:00.000Z`
  const rows = [
    // An overnight print, in FF's own 00:00-04:00 window. Every other
    // timed row here is built at the VIEWER's wall clock, so its local day
    // matches the fixture author's intent in every zone by construction -
    // which is half of what displayDayFor exists to get right. This one is
    // pinned to an instant instead, so it genuinely lands on a different
    // local day for a viewer west of FF.
    [2, 1, 30, 'BOJ Gov Ueda Speaks', 'USD', 'medium', 'Speeches', null, null, null, null],
    [1, 10, 0, 'Fed Chair Powell Speaks', 'USD', 'medium', 'Speeches', null, null, null, null],
    [1, 14, 0, '10-y Bond Auction', 'USD', 'low', 'Bonds', null, '4.28%', null, null],
    [2, 8, 30, 'CPI m/m', 'USD', 'high', 'Inflation', '0.3%', '0.2%', '0.4%', 'worse'],
    [2, 10, 0, 'CB Consumer Confidence', 'USD', 'medium', 'Consumer Surveys', '98.5', '97.2', '99.1', 'better'],
    [2, 4, 30, 'Official Bank Rate', 'GBP', 'high', 'Central Bank', '4.75%', '5.00%', '4.75%', null],
    [3, 8, 30, 'Unemployment Claims', 'USD', 'medium', 'Employment', '224K', '221K', null, null],
    [3, 10, 30, 'Crude Oil Inventories', 'USD', 'low', 'Misc', '-1.2M', '2.4M', null, null],
    [3, 5, 0, 'German Ifo Business Climate', 'EUR', 'medium', 'Business Surveys', '86.1', '85.4', null, null],
    [4, 8, 30, 'Retail Sales m/m', 'USD', 'high', 'Growth', '0.4%', '0.6%', null, null],
    [4, 10, 0, 'Existing Home Sales', 'USD', 'medium', 'Housing', '3.95M', '3.83M', null, null],
    [4, 21, 30, 'Employment Change', 'AUD', 'high', 'Employment', '25.2K', '15.9K', null, null],
    [5, 0, 0, 'Bank Holiday', 'JPY', 'holiday', 'Misc', null, null, null, null],
    // A MEDIUM-impact all-day row in a currency the default filter shows.
    // Without one, neither the news badge (high/medium only) nor the
    // default USD-only card could render an all-day row at all - so the
    // day-derivation bug that shipped twice was invisible to both.
    // German Prelim CPI is the real archetype.
    [3, 0, 0, 'German Prelim CPI m/m', 'USD', 'medium', 'Inflation', '0.2%', '0.3%', null, null],
    [5, 8, 30, 'Core PCE Price Index m/m', 'USD', 'high', 'Inflation', '0.2%', '0.3%', null, null],
    // FF files events with no single home currency under country "All" -
    // real, and easy to leave unfilterable, so the fixture carries one.
    [4, 7, 0, 'OPEC-JMMC Meetings', 'ALL', 'medium', 'Misc', null, null, null, null],
  ]
  const thisWeek = rows.map(([day, hh, mm, title, currency, impact, event_type, forecast, previous, actual, actual_status], i) => {
    const allDay = hh === 0 && mm === 0
    const event_time = allDay ? ffAllDayAt(day) : at(day, hh, mm)
    // FF's own day, which is what both writers now put at the front of the
    // key - taken from the day offset rather than re-derived from the
    // instant, since for an all-day row those are the two things that
    // disagree.
    const ffDay = dayOf(day)
    // Production keys on FF's own event id, and the day lives in the
    // columns rather than the key. The fixture used to build a day-based
    // key, which is precisely how a key-format change slipped through
    // unnoticed - the mock agreed with the old shape by construction.
    const ffId = String(170000 + i)
    return {
      event_key: `ff|${ffId}`,
      title,
      currency,
      event_time,
      impact,
      event_type,
      forecast,
      previous,
      actual,
      actual_status,
      // German Prelim CPI is FF's classic all-day row; the Bank Holiday
      // here stands in for one, so the card's non-clock rendering path
      // gets exercised too.
      time_precision: allDay ? 'all_day' : 'exact',
      previous_revised: title === 'CB Consumer Confidence',
      ff_event_id: ffId,
      detail_url: 'https://www.forexfactory.com/calendar',
      fetched_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }
  })

  // PAST PRINTS of the recurring releases above, so the brief terminal's
  // `record` line has something to read. Without these the fixture is one
  // week wide and consensusBias could never reach its three-print minimum,
  // which meant that line silently never rendered in mock mode - the
  // feature looked finished while one of its rows had never once been seen.
  //
  // Monthly, counting back from the current week, with actuals that make
  // each release's record distinguishable on sight: CPI runs hot (every
  // print above forecast), PPI runs cold, Retail Sales is genuinely mixed.
  // Real FF ids so they key the same way production rows do.
  const HISTORY = [
    ['CPI m/m', 'high', 'Inflation', ['0.4%', '0.5%', '0.4%', '0.5%'], '0.3%'],
    ['PPI m/m', 'medium', 'Inflation', ['0.1%', '0.0%', '0.1%', '0.1%'], '0.2%'],
    ['Retail Sales m/m', 'high', 'Growth', ['0.5%', '0.2%', '0.4%', '0.3%'], '0.4%'],
  ]
  const past = []
  HISTORY.forEach(([title, impact, event_type, actuals, forecast], t) => {
    actuals.forEach((actual, m) => {
      const d = new Date(sunday)
      // One month back per step, at 08:30 local - far enough before today
      // that fetchReleaseHistory's `lt(now)` always includes them.
      d.setMonth(d.getMonth() - (m + 1))
      d.setDate(12)
      d.setHours(8, 30, 0, 0)
      const ffId = String(160000 + t * 100 + m)
      past.push({
        event_key: `ff|${ffId}`,
        title, currency: 'USD', event_time: d.toISOString(), impact, event_type,
        forecast, previous: forecast, actual,
        actual_status: Number(actual.replace('%', '')) > Number(forecast.replace('%', '')) ? 'worse' : 'better',
        time_precision: 'exact', previous_revised: false, ff_event_id: ffId,
        detail_url: 'https://www.forexfactory.com/calendar',
        fetched_at: new Date().toISOString(), created_at: new Date().toISOString(),
      })
    })
  })
  return [...thisWeek, ...past]
})()

if (typeof window !== 'undefined') {
  // Lets a Playwright script read/assert against live mock state, e.g.
  // `page.evaluate(() => window.__MOCK_TRADES__)`.
  window.__MOCK_TRADES__ = MOCK_TRADES
  window.__MOCK_EDGE_INSIGHTS__ = MOCK_EDGE_INSIGHTS
  window.__MOCK_USER__ = MOCK_USER
}

// Tables whose real schema.sql definition has an `archived` column - see
// insert()'s own comment below for why this matters.
const ARCHIVABLE_TABLES = new Set(['instruments', 'strategies'])

function tableFor(name) {
  if (name === 'instruments') return MOCK_INSTRUMENTS
  if (name === 'strategies') return MOCK_STRATEGIES
  if (name === 'trades') return MOCK_TRADES
  if (name === 'edge_insights') return MOCK_EDGE_INSIGHTS
  if (name === 'economic_events') return MOCK_ECONOMIC_EVENTS
  if (name === 'econ_release_detail') return MOCK_ECON_RELEASE_DETAIL
  if (name === 'econ_release_revision') return MOCK_ECON_RELEASE_REVISION
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
  // Artificial per-query latency, in milliseconds, from
// NEXT_PUBLIC_MOCK_LATENCY_MS (unset or 0 = instant, the default).
//
// This exists because a mock that resolves instantly cannot reproduce an
// entire class of real bug, and worse, makes a broken fix look verified. A
// perceived-slowness fix was once "confirmed" against this client and
// shipped having changed nothing measurable, precisely because every call
// here returned before the first paint. Loading states, spinner flashes,
// and any race between two in-flight loads (click one instrument, then
// another) only exist when a query takes time.
//
// NEXT_PUBLIC_MOCK_LATENCY_PER_ROW_MS adds a further delay per row returned.
// Uniform latency alone cannot reproduce a race between two in-flight loads:
// if every query takes the same time, the one started second also finishes
// second, which is the right order by accident. Real queries scale with how
// much they return, and that is what lets a heavy earlier load land after a
// light later one.
//
// Usage:
//   NEXT_PUBLIC_MOCK_LATENCY_MS=300 npm run dev:mock
//   NEXT_PUBLIC_MOCK_LATENCY_MS=150 NEXT_PUBLIC_MOCK_LATENCY_PER_ROW_MS=25 npm run dev:mock
// Per-table latency is deliberately not offered - the point is to make
// everything slow enough to observe, not to model a real query planner.
const MOCK_LATENCY_MS = Number(process.env.NEXT_PUBLIC_MOCK_LATENCY_MS) || 0
const MOCK_LATENCY_PER_ROW_MS = Number(process.env.NEXT_PUBLIC_MOCK_LATENCY_PER_ROW_MS) || 0

function withLatency(value, rowCount = 0) {
  const delay = MOCK_LATENCY_MS + MOCK_LATENCY_PER_ROW_MS * rowCount
  if (delay <= 0) return Promise.resolve(value)
  return new Promise((resolve) => setTimeout(() => resolve(value), delay))
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
    // Inclusive bounds, used by lib/econCalendarQuery.js to select the
    // instants bounding a local calendar day. String comparison is right
    // for the ISO timestamps stored here for the same reason it is in
    // Postgres: ISO-8601 UTC strings sort chronologically as text.
    gte: (k, v) => { state.rows = state.rows.filter((r) => r[k] != null && r[k] >= v); return api },
    lte: (k, v) => { state.rows = state.rows.filter((r) => r[k] != null && r[k] <= v); return api },
    is: (k, v) => { state.rows = state.rows.filter((r) => (v === null ? (r[k] === null || r[k] === undefined) : r[k] === v)); return api },
    in: (k, vals) => { state.rows = state.rows.filter((r) => (vals || []).includes(r[k])); return api },
    // Narrow on purpose, like `or` below: the only negation any caller
    // makes is .not('actual', 'is', null) - "this release has printed" in
    // lib/econCalendarQuery's fetchReleaseHistory. Anything else throws
    // rather than silently returning the unfiltered set, which is how a
    // mock quietly stops resembling the database it stands in for.
    not: (k, op, v) => {
      if (op !== 'is') throw new Error(`mock supabase: .not() supports only the 'is' operator, got '${op}'`)
      state.rows = state.rows.filter((r) => (v === null ? (r[k] !== null && r[k] !== undefined) : r[k] !== v))
      return api
    },
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
      if (rows.length === 0) return withLatency({ data: null, error: { code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object' } })
      return withLatency({ data: rows[0], error: null })
    },
    // Same as single() but zero rows is a plain { data: null }, not an
    // error - matches real PostgREST's own maybeSingle semantics.
    maybeSingle: async () => withLatency({ data: sortedRows()[0] ?? null, error: null }),
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
    then: (resolve, reject) => {
      const rows = sortedRows()
      withLatency({ data: rows, error: null, count: state.wantCount ? (state.count ?? rows.length) : undefined }, rows.length).then(resolve, reject)
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


// ---------------------------------------------------------------------
// MFA, simulated properly rather than stubbed out.
// ---------------------------------------------------------------------
// This used to be one line - `listFactors` returning an empty array -
// which meant the entire two-factor surface was unreachable in mock mode:
// no enrolment screen, no QR code, no verify step, no recovery codes, no
// login challenge. Every one of those had to be checked against the real
// database, i.e. against a real account on the production project, which
// CLAUDE.md's non-negotiables exist to stop.
//
// IT REPRODUCES THE FAILURES, NOT JUST THE HAPPY PATH. A mock that only
// succeeds is worse than none: the production code carries a workaround
// for Supabase refusing to enrol while an unverified factor is lying
// around, and against an always-succeeding mock that workaround is dead
// code nobody can test. So enroll() rejects exactly as the real server
// does, and the cleanup is exercised every time.
//
// THE CODE IS FIXED AND THE SECRET IS FAKE. Implementing real RFC 6238
// TOTP here would make the mock harder to drive and no more faithful for
// UI purposes - what matters is that a right code is accepted, a wrong
// one is refused, and both paths render. MOCK_TOTP_CODE is the right one.
export const MOCK_TOTP_CODE = '123456'

// A real-looking QR: a scannable-shaped block pattern as an inline SVG
// data URI, the same form Supabase returns, so .mfa-qr-wrap's white card,
// padding and explicit sizing are all exercised for real. Deliberately
// not an actual encoded otpauth:// payload - nothing should be able to
// enrol a real authenticator against the mock.
const MOCK_QR = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" shape-rendering="crispEdges">'
  + '<rect width="200" height="200" fill="#fff"/>'
  + Array.from({ length: 400 }, (_, i) => {
    const x = i % 20, y = Math.floor(i / 20)
    // Deterministic pseudo-pattern plus the three finder squares, so it
    // reads as a QR code at a glance in a screenshot.
    const finder = (x < 7 && y < 7) || (x > 12 && y < 7) || (x < 7 && y > 12)
    const on = finder ? ((x + y) % 2 === 0 || x === 0 || y === 0) : ((x * 7 + y * 13) % 5 < 2)
    return on ? `<rect x="${x * 10}" y="${y * 10}" width="10" height="10" fill="#000"/>` : ''
  }).join('')
  + '</svg>'
)

let MOCK_FACTORS = []
let MOCK_RECOVERY = null          // { id, total, remaining, codes }
let MOCK_CHALLENGES = {}
let MOCK_AAL_SATISFIED = false    // set once a verify() succeeds this session
let mockIdSeq = 0
const mockId = (p) => `${p}-${++mockIdSeq}`

// Lets a verification run start from a chosen 2FA state without editing
// this file, matching the mockTutorialStatus pattern above. e.g.
//   ?mockMfa=enabled      one verified TOTP factor
//   ?mockMfa=two          two verified factors, to exercise the list
//   ?mockMfa=recovery     enabled, with recovery codes already generated
if (typeof window !== 'undefined') {
  const mp = new URLSearchParams(window.location.search)
  const want = mp.get('mockMfa')
  if (want === 'enabled' || want === 'two' || want === 'recovery') {
    MOCK_FACTORS.push({
      id: mockId('factor'), friendly_name: 'Phone', factor_type: 'totp', status: 'verified',
      created_at: new Date(Date.now() - 86400000).toISOString(), updated_at: new Date().toISOString(),
    })
  }
  if (want === 'two') {
    MOCK_FACTORS.push({
      id: mockId('factor'), friendly_name: 'iPad', factor_type: 'totp', status: 'verified',
      created_at: new Date(Date.now() - 3600000).toISOString(), updated_at: new Date().toISOString(),
    })
  }
  if (want === 'recovery') {
    MOCK_RECOVERY = {
      id: mockId('rc'), total: 10, remaining: 8,
      codes: Array.from({ length: 10 }, (_, i) => `MOCK-${String(i).padStart(4, '0')}-CODE`),
    }
  }
}

// Shaped like a real Supabase access token so that code which decodes
// its claims has something valid to read. Not signed, and nothing in
// mock mode ever verifies it - the real client is not in play here.
const MOCK_ACCESS_TOKEN = (() => {
  // btoa, not Buffer: this module runs in the browser, where Buffer
  // does not exist and referencing it throws at module load - which
  // would take the whole mock client down rather than just this token.
  const b64 = (o) => btoa(JSON.stringify(o))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const payload = { sub: 'mock-user', aal: 'aal1', amr: [{ method: 'otp', timestamp: 0 }] }
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.mock-signature`
})()

const mockErr = (message, code) => ({ data: null, error: { message, code, name: 'AuthApiError' } })

const mockMfaApi = {
  listFactors: async () => ({
    data: {
      all: MOCK_FACTORS.slice(),
      totp: MOCK_FACTORS.filter((f) => f.factor_type === 'totp'),
      phone: [],
    },
    error: null,
  }),

  // Mirrors the real refusal: a second enrolment while one is unverified
  // is rejected, which is exactly what the production cleanup works
  // around. Without this the workaround would be untested.
  enroll: async ({ factorType = 'totp', friendlyName } = {}) => {
    if (MOCK_FACTORS.some((f) => f.status !== 'verified')) {
      return mockErr('A factor with this friendly name already exists', 'mfa_factor_name_conflict')
    }
    if (friendlyName && MOCK_FACTORS.some((f) => f.friendly_name === friendlyName)) {
      return mockErr('A factor with this friendly name already exists', 'mfa_factor_name_conflict')
    }
    const factor = {
      id: mockId('factor'),
      friendly_name: friendlyName,
      factor_type: factorType,
      status: 'unverified',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    MOCK_FACTORS.push(factor)
    return {
      data: {
        id: factor.id,
        type: factorType,
        friendly_name: friendlyName,
        totp: { qr_code: MOCK_QR, secret: 'MOCKSECRETJBSWY3DPEHPK3PXP', uri: 'otpauth://totp/mock' },
      },
      error: null,
    }
  },

  challenge: async ({ factorId }) => {
    if (!MOCK_FACTORS.some((f) => f.id === factorId)) {
      return mockErr('Factor not found', 'mfa_factor_not_found')
    }
    const id = mockId('challenge')
    MOCK_CHALLENGES[id] = { factorId, at: Date.now() }
    return { data: { id, type: 'totp', expires_at: Date.now() + 300000 }, error: null }
  },

  verify: async ({ factorId, challengeId, code }) => {
    const ch = MOCK_CHALLENGES[challengeId]
    if (!ch || ch.factorId !== factorId) {
      return mockErr('Challenge not found', 'mfa_challenge_expired')
    }
    if (String(code).trim() !== MOCK_TOTP_CODE) {
      return mockErr('Invalid TOTP code entered', 'mfa_verification_failed')
    }
    const factor = MOCK_FACTORS.find((f) => f.id === factorId)
    if (factor) { factor.status = 'verified'; factor.updated_at = new Date().toISOString() }
    delete MOCK_CHALLENGES[challengeId]
    MOCK_AAL_SATISFIED = true
    return { data: { access_token: 'mock-aal2', user: MOCK_USER }, error: null }
  },

  unenroll: async ({ factorId }) => {
    const before = MOCK_FACTORS.length
    MOCK_FACTORS = MOCK_FACTORS.filter((f) => f.id !== factorId)
    if (MOCK_FACTORS.length === before) return mockErr('Factor not found', 'mfa_factor_not_found')
    if (!MOCK_FACTORS.some((f) => f.status === 'verified')) MOCK_AAL_SATISFIED = false
    return { data: { id: factorId }, error: null }
  },

  getAuthenticatorAssuranceLevel: async () => {
    const hasVerified = MOCK_FACTORS.some((f) => f.status === 'verified')
    return {
      data: {
        currentLevel: MOCK_AAL_SATISFIED ? 'aal2' : 'aal1',
        nextLevel: hasVerified ? 'aal2' : 'aal1',
        currentAuthenticationMethods: [],
      },
      error: null,
    }
  },

  recoveryCodes: {
    getStatus: async () => (MOCK_RECOVERY
      ? { data: { id: MOCK_RECOVERY.id, type: 'recovery_code', total: MOCK_RECOVERY.total, remaining: MOCK_RECOVERY.remaining }, error: null }
      : mockErr('No recovery codes found', 'mfa_factor_not_found')),

    generate: async ({ friendlyName } = {}) => {
      if (MOCK_RECOVERY) return mockErr('Recovery codes already exist', 'mfa_verified_factor_exists')
      const codes = Array.from({ length: 10 }, (_, i) => `MOCK-${String(i).padStart(4, '0')}-CODE`)
      MOCK_RECOVERY = { id: mockId('rc'), total: codes.length, remaining: codes.length, codes }
      return { data: { id: MOCK_RECOVERY.id, type: 'recovery_code', friendly_name: friendlyName, total: codes.length, codes }, error: null }
    },

    regenerate: async () => {
      if (!MOCK_RECOVERY) return mockErr('No recovery codes to regenerate', 'mfa_factor_not_found')
      const codes = Array.from({ length: 10 }, (_, i) => `NEW-${String(i).padStart(4, '0')}-CODE`)
      MOCK_RECOVERY = { id: MOCK_RECOVERY.id, total: codes.length, remaining: codes.length, codes }
      return { data: { id: MOCK_RECOVERY.id, type: 'recovery_code', total: codes.length, codes }, error: null }
    },

    verify: async ({ code }) => {
      if (!MOCK_RECOVERY) return mockErr('No recovery codes found', 'mfa_factor_not_found')
      const idx = MOCK_RECOVERY.codes.indexOf(String(code).trim().toUpperCase())
      if (idx === -1) return mockErr('Invalid recovery code', 'mfa_verification_failed')
      // A used code is spent - the real server will not accept it twice.
      MOCK_RECOVERY.codes.splice(idx, 1)
      MOCK_RECOVERY.remaining = Math.max(0, MOCK_RECOVERY.remaining - 1)
      MOCK_AAL_SATISFIED = true
      return { data: { access_token: 'mock-aal2', user: MOCK_USER }, error: null }
    },

    unenroll: async () => { MOCK_RECOVERY = null; return { data: {}, error: null } },
  },
}

export const supabase = {
  auth: {
    getUser: async () => ({ data: { user: MOCK_USER }, error: null }),
    // A session with NO access_token looked harmless until a code path
    // that posts one to a server route was verified against it: the
    // fetch never fired, the caller reported a failure, and the mock
    // made a working feature look broken - the mirror image of the trap
    // CLAUDE.md warns about. The token is shaped like a real JWT,
    // header.payload.signature, so anything that decodes claims out of
    // it (lib/authAssurance.js) gets something to read rather than
    // throwing. The payload says aal1 with a single otp method, which
    // is exactly what the live auth server returns for a password
    // recovery - measured by scripts/probe-recovery-session.js, not
    // invented here.
    getSession: async () => ({ data: { session: { user: MOCK_USER, access_token: MOCK_ACCESS_TOKEN } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    mfa: mockMfaApi,
    // Mirrors the real reauthenticate(): it sends a nonce out of band and
    // returns nothing useful here. Present so the re-auth path can be
    // driven in mock mode at all.
    reauthenticate: async () => ({ data: {}, error: null }),
    signInWithPassword: async ({ password }) => (password === 'password'
      ? { data: { user: MOCK_USER, session: { user: MOCK_USER } }, error: null }
      : mockErr('Invalid login credentials', 'invalid_credentials')),
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
