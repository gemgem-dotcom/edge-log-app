#!/usr/bin/env node

// One-time rebuild of every user's edge_beliefs rows from their trade
// history - needed because edge_beliefs is a derived cache, not a source
// of truth, and most of the slice types it now tracks (outcome,
// day_of_week, discipline tags, every composite, MFE/MAE/drawdown, dollar
// P&L) didn't exist when older trades were originally saved. Those trades
// already contributed to the *old* slice types (session, strategy,
// instrument, discipline) at save time, so there's no safe way to just
// "add what's missing" without risking double-counting - the only fully
// correct approach is to delete every belief row for a user and replay
// their entire trade history from scratch, in chronological order,
// through the exact same applyTrade/applyExcursion functions the app
// itself calls on every save.
//
// Chronological (trade_date, then trade_time as a tiebreaker - same sort
// key lib/streak.js uses) rather than insertion order: the seed a
// brand-new slice inherits depends on its parent's state *at the moment
// that slice is first created*, so replaying in the order trades actually
// happened is the most faithful reconstruction of what the running
// posteriors would have looked like if this system had existed all
// along. The final win_alpha/avg_r_mean/etc. numbers themselves are
// order-independent (Welford's algorithm doesn't care what order values
// arrive in) - only the very first few seeds in a slice's life are
// order-sensitive, and chronological order is the only order that means
// anything here.
//
// Safety: defaults to a dry run (reports what it would do - trade counts
// per user, nothing written) unless --apply is passed. This is a
// destructive, one-time migration against production data, not a
// recurring job - worth a deliberate confirmation step, unlike the hourly
// retry script this borrows its dynamic-import pattern from.
//
// Usage:
//   node scripts/backfill-edge-beliefs.js            (dry run)
//   node scripts/backfill-edge-beliefs.js --apply     (actually rebuild)
// Env: SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL

const { createClient } = require('@supabase/supabase-js')

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

// Dynamically imports the real applyTrade/applyExcursion from
// lib/edgeBeliefs.js rather than keeping a duplicate copy of the whole
// belief-update system - see scripts/retry-trade-excursions.js's own
// header comment (and the CONSTRAINT comment atop lib/edgeEngine.js) for
// why this works and what it requires of that file. Unlike the hourly
// retry script, this one has no excursion math of its own to duplicate -
// every write here goes through the real applyTrade/applyExcursion, so
// there's nothing to keep in sync with a second copy.
async function loadBeliefHelpers() {
  const mod = await import('../lib/edgeBeliefs.js')
  return { applyTrade: mod.applyTrade, applyExcursion: mod.applyExcursion }
}

function hasResult(trade) {
  return trade.r_multiple !== null && trade.r_multiple !== undefined
}

function sortKey(trade) {
  return `${trade.trade_date}${trade.trade_time || ''}`
}

// Pure grouping/sorting logic, pulled out of main() so it's directly
// unit-testable without a real (or fake) Supabase client - the only new
// logic this script actually introduces; the belief-rebuilding math
// itself is exactly the same applyTrade/applyExcursion the app already
// calls on every save, already verified extensively elsewhere.
function groupAndSortByUser(trades) {
  const byUser = new Map()
  for (const trade of trades) {
    if (!hasResult(trade)) continue
    if (!byUser.has(trade.user_id)) byUser.set(trade.user_id, [])
    byUser.get(trade.user_id).push(trade)
  }
  for (const userTrades of byUser.values()) {
    userTrades.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
  }
  return byUser
}

// Orchestration, with admin/helpers/dryRun injected rather than
// constructed inline - lets a test call this directly with a fake admin
// client and fake helpers, without needing real Supabase credentials or
// monkey-patching createClient.
async function runBackfill({ admin, helpers, dryRun, trades }) {
  const byUser = groupAndSortByUser(trades)

  log(`${trades.length} closed trade(s) across ${byUser.size} user(s).`)
  if (dryRun) {
    log('DRY RUN - no changes will be made. Pass --apply to actually rebuild.')
  }

  let totalApplied = 0
  let totalExcursionApplied = 0

  for (const [userId, userTrades] of byUser) {
    log(`user ${userId}: ${userTrades.length} trade(s) to replay${dryRun ? ' (dry run)' : ''}`)
    if (dryRun) continue

    const { error: deleteError } = await admin.from('edge_beliefs').delete().eq('user_id', userId)
    if (deleteError) throw new Error(`Failed to clear edge_beliefs for user ${userId}: ${deleteError.message}`)

    for (const trade of userTrades) {
      await helpers.applyTrade(admin, trade)
      totalApplied += 1
      if (trade.mfe_points != null) {
        await helpers.applyExcursion(admin, trade)
        totalExcursionApplied += 1
      }
    }
  }

  if (dryRun) {
    log('Dry run complete - re-run with --apply to actually rebuild edge_beliefs.')
  } else {
    log(`Done. Replayed ${totalApplied} trade(s) (${totalExcursionApplied} with excursion data) across ${byUser.size} user(s).`)
  }
  return { userCount: byUser.size, totalApplied, totalExcursionApplied }
}

async function main() {
  const dryRun = !process.argv.includes('--apply')

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')
  const admin = createClient(supabaseUrl, serviceKey)

  // Fails immediately and loudly if lib/edgeBeliefs.js ever stops being
  // importable from plain Node - same reasoning as the retry script's own
  // guard, just as relevant here since this script uses the exact same
  // mechanism.
  let helpers
  try {
    helpers = await loadBeliefHelpers()
  } catch (err) {
    console.error('CRITICAL: could not load lib/edgeBeliefs.js - cannot rebuild belief state.', err)
    throw err
  }

  const { data: trades, error } = await admin
    .from('trades')
    .select('*')
    .not('r_multiple', 'is', null)
  if (error) throw new Error(`Failed to load trades: ${error.message}`)

  await runBackfill({ admin, helpers, dryRun, trades })
}

// Guarded so a test can require() this file for groupAndSortByUser/
// runBackfill without triggering a real run against real credentials.
if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

module.exports = { groupAndSortByUser, runBackfill, hasResult, sortKey }
