// Aliased (not a bare relative './supabaseClient') so next.config.js's
// mock-DB webpack plugin - which matches on the literal import-specifier
// string ending in `lib/supabaseClient` - actually catches this import.
// A same-directory relative path from a file that itself lives in lib/
// would just be './supabaseClient', which doesn't contain that substring
// and silently falls through to the REAL client even in dev:mock mode
// (confirmed live: every queryBeliefs() call returned an empty Map against
// the mock DB until this was fixed, since supabase.auth.getUser() against
// the real, uncredentialed client resolves to no user).
import { supabase } from '@/lib/supabaseClient'

// Read-side companion to lib/edgeBeliefs.js - that module keeps edge_beliefs
// updated incrementally at trade save/edit/delete time; this module is the
// one place UI code goes to actually read a slice's posterior back out in a
// display-ready shape, so the "don't surface a win rate for outcome:
// slices" rule and the confidence-tier gating only need to be encoded once
// instead of separately in every dashboard panel that wants a belief.
//
// Unlike lib/edgeEngine.js's queryPerformance (which recomputes from the
// full trades array on every call, no I/O), this always goes to the
// database - edge_beliefs is what it exists to read.

// True when a slice_key's own definition already fixes its outcome, making
// win_alpha/win_beta a restatement of the slice rather than a measurement -
// see the long WARNING above BASE_DIMENSIONS.outcome in lib/edgeEngine.js
// and the matching one above `create table edge_beliefs` in schema.sql.
// avg_r_mean/expectancy_mean/n stay meaningful for these slices; only the
// derived win rate is degenerate.
function isOutcomeDegenerate(sliceKey) {
  return sliceKey.split('|').some((segment) => segment.startsWith('outcome:'))
}

// Shapes one raw edge_beliefs row into what a dashboard panel actually
// wants to render - never the raw alpha/beta or Welford (mean, m2) pairs
// directly, so a display bug can't silently disagree with how
// lib/edgeBeliefs.js itself interprets those columns.
function shapeBelief(row) {
  if (!row) return null

  const degenerate = isOutcomeDegenerate(row.slice_key)
  const winRate = degenerate ? null : (row.win_alpha / (row.win_alpha + row.win_beta)) * 100

  const hasExcursion = (row.excursion_n ?? 0) > 0
  const hasPnl = (row.pnl_n ?? 0) > 0

  return {
    sliceKey: row.slice_key,
    bindings: row.bindings,
    n: row.n,
    confidenceTier: row.confidence_tier,
    winRate,
    winRateDegenerate: degenerate,
    avgR: row.avg_r_mean ?? null,
    expectancy: row.expectancy_mean ?? null,
    recentOutcomes: row.recent_outcomes || [],
    lastTradeAt: row.last_trade_at,
    excursion: hasExcursion
      ? { mfeR: row.mfe_r_mean, maeR: row.mae_r_mean, drawdownSeconds: row.drawdown_seconds_mean, n: row.excursion_n }
      : null,
    pnl: hasPnl ? { mean: row.pnl_mean, n: row.pnl_n } : null,
  }
}

// Fetches one or more slices by key for the current user and returns a Map
// keyed by slice_key, each value already shaped via shapeBelief (or the Map
// simply omitting a key that has no row yet - a slice with zero trades was
// never created, same "no row means no data" convention
// fetchBeliefsByKeys in lib/edgeBeliefs.js already uses). Batches every key
// into one request regardless of how many a caller needs, the same
// motivation as that function's own comment.
export async function queryBeliefs(sliceKeys) {
  const keys = [...new Set(sliceKeys)].filter(Boolean)
  if (keys.length === 0) return new Map()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Map()

  const { data, error } = await supabase
    .from('edge_beliefs')
    .select('*')
    .eq('user_id', user.id)
    .in('slice_key', keys)
  if (error) throw error

  return new Map(data.map((row) => [row.slice_key, shapeBelief(row)]))
}

// Convenience for the common single-slice case - a thin wrapper over
// queryBeliefs so call sites that only want one slice don't need to unwrap
// a one-entry Map themselves. Returns null if the slice doesn't exist yet.
export async function queryBelief(sliceKey) {
  if (!sliceKey) return null
  const beliefs = await queryBeliefs([sliceKey])
  return beliefs.get(sliceKey) ?? null
}

export { isOutcomeDegenerate }
