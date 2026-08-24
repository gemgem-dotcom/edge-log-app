import { hasResult } from './tradeMath'
import { DIMENSIONS } from './edgeEngine'

// Incremental companion to lib/edgeEngine.js's queryPerformance() - see the
// long comment above `create table edge_beliefs` in schema.sql for the full
// picture. queryPerformance recomputes a slice's stats from the trades table
// on every read; this module instead keeps a running posterior per slice in
// the edge_beliefs table, updated at trade save/edit/delete time so later
// features (e.g. the Today's Brief clause) don't need to rescan trade
// history just to ask "have we seen this before, and how did it go."
//
// Call applyTrade(supabase, trade) after an insert, reverseTrade(supabase,
// trade) before/after a delete, and for an edit call reverseTrade with the
// pre-edit row followed by applyTrade with the post-edit row - slice
// membership itself can change on an edit (a reassigned strategy, a
// discipline review), so reversing the old slice set and applying the new
// one is correct where "patch the existing row" would not be.

const PSEUDO_COUNT = 10
const RECENT_OUTCOMES_CAP = 20

// One entry per single-dimension slice this trade participates in, each
// carrying the parent it should be seeded from if this is the first trade
// ever seen in that slice. 'overall' is the root every single-dimension
// slice hangs off; it has no parent of its own. Kept intentionally in sync
// with lib/edgeEngine.js's DIMENSIONS - a trade belongs to a belief slice
// exactly when it would appear in that dimension's queryPerformance group,
// reusing the very same extractors rather than a second copy of this logic.
function singleDimensionSlices(trade) {
  const slices = [{ sliceKey: 'overall', bindings: {}, parentSliceKey: null }]

  const session = DIMENSIONS.session(trade)
  if (session != null) {
    slices.push({ sliceKey: `session:${session}`, bindings: { session }, parentSliceKey: 'overall' })
  }

  const strategyId = DIMENSIONS.strategy_id(trade)
  if (strategyId != null) {
    slices.push({ sliceKey: `strategy_id:${strategyId}`, bindings: { strategy_id: strategyId }, parentSliceKey: 'overall' })
  }

  const instrumentId = DIMENSIONS.instrument_id(trade)
  if (instrumentId != null) {
    slices.push({ sliceKey: `instrument_id:${instrumentId}`, bindings: { instrument_id: instrumentId }, parentSliceKey: 'overall' })
  }

  const discipline = DIMENSIONS.discipline(trade)
  slices.push({ sliceKey: `discipline:${discipline}`, bindings: { discipline }, parentSliceKey: 'overall' })

  return slices
}

// Regime slices (volatility_regime, volume_regime, and their strategy_id
// intersections) - NQ-family trades only, and only once lib/tradeRegimes.js
// has backfilled the trade's own regime columns (null until then, same
// "not yet applicable" rule as everywhere else in this system). Reuses
// DIMENSIONS' own extractors/composite-key format, same as
// singleDimensionSlices above, so belief slicing never drifts from what
// queryPerformance actually groups by.
function regimeSlices(trade) {
  const slices = []

  const volatilityRegime = DIMENSIONS.volatility_regime(trade)
  if (volatilityRegime != null) {
    slices.push({ sliceKey: `volatility_regime:${volatilityRegime}`, bindings: { volatility_regime: volatilityRegime }, parentSliceKey: 'overall' })
  }
  const volumeRegime = DIMENSIONS.volume_regime(trade)
  if (volumeRegime != null) {
    slices.push({ sliceKey: `volume_regime:${volumeRegime}`, bindings: { volume_regime: volumeRegime }, parentSliceKey: 'overall' })
  }

  const strategyId = DIMENSIONS.strategy_id(trade)
  if (strategyId != null) {
    const strategyVolatilityKey = DIMENSIONS['strategy_id_x_volatility_regime'](trade)
    if (strategyVolatilityKey != null) {
      slices.push({ sliceKey: strategyVolatilityKey, bindings: { strategy_id: strategyId, volatility_regime: volatilityRegime }, parentSliceKey: `strategy_id:${strategyId}` })
    }
    const strategyVolumeKey = DIMENSIONS['strategy_id_x_volume_regime'](trade)
    if (strategyVolumeKey != null) {
      slices.push({ sliceKey: strategyVolumeKey, bindings: { strategy_id: strategyId, volume_regime: volumeRegime }, parentSliceKey: `strategy_id:${strategyId}` })
    }
  }

  return slices
}

// The full capped slice list for a trade - every slice this trade should
// touch on save/edit/delete.
function slicesForTrade(trade) {
  return [...singleDimensionSlices(trade), ...regimeSlices(trade)]
}

// Welford's online algorithm - add one sample to a running (mean, m2, count).
// m2 is the running sum of squared deviations from the mean (what Welford's
// method tracks instead of variance directly, since it stays numerically
// stable one sample at a time); variance is m2/count when you need it.
function welfordAdd(mean, m2, count, value) {
  const newCount = count + 1
  const delta = value - mean
  const newMean = mean + delta / newCount
  const delta2 = value - newMean
  const newM2 = m2 + delta * delta2
  return { mean: newMean, m2: newM2, count: newCount }
}

// The exact inverse of welfordAdd - remove one sample, recovering the
// (mean, m2, count) as they were immediately before that sample was added.
// Used to reverse a trade's contribution on edit/delete. At count 1 -> 0
// there is no previous mean to divide back out to, so the accumulator just
// resets to its zero state.
function welfordRemove(mean, m2, count, value) {
  const newCount = count - 1
  if (newCount <= 0) return { mean: 0, m2: 0, count: 0 }
  const newMean = (mean * count - value) / newCount
  const delta = value - newMean
  const delta2 = value - mean
  const newM2 = m2 - delta * delta2
  return { mean: newMean, m2: newM2, count: newCount }
}

function confidenceTierFor(n) {
  if (n < 20) return 'too_early'
  if (n < 50) return 'early_signal'
  return 'trustworthy'
}

function outcomeFor(trade) {
  return { trade_id: trade.id, r_multiple: trade.r_multiple, trade_date: trade.trade_date }
}

// A brand-new slice row, seeded from its parent's current posterior (scaled
// by a fixed pseudo-count) rather than an uninformative prior - so a slice
// no trade has ever landed in yet before still starts from "what we already
// believe" about the coarser slice it sits inside. The root 'overall' slice
// has no parent, so it seeds from a flat, uninformative Beta(1,1) instead.
function seedFromParent(parent) {
  if (!parent) {
    return { win_alpha: 1, win_beta: 1, expectancy_mean: 0, expectancy_m2: 0, avg_r_mean: 0, avg_r_m2: 0 }
  }
  const posteriorMean = parent.win_alpha / (parent.win_alpha + parent.win_beta)
  return {
    win_alpha: posteriorMean * PSEUDO_COUNT,
    win_beta: (1 - posteriorMean) * PSEUDO_COUNT,
    // The mean carries over as the best available prior; m2 starts at 0
    // since there's no per-sample history to inherit from the parent's own
    // accumulator - real trades in this slice build its variance back up
    // from there via welfordAdd.
    expectancy_mean: parent.expectancy_mean ?? 0,
    expectancy_m2: 0,
    avg_r_mean: parent.avg_r_mean ?? 0,
    avg_r_m2: 0,
  }
}

async function fetchBelief(supabase, userId, sliceKey) {
  const { data, error } = await supabase
    .from('edge_beliefs')
    .select('*')
    .eq('user_id', userId)
    .eq('slice_key', sliceKey)
    .maybeSingle()
  if (error) throw error
  return data
}

// Apply one trade's outcome to one slice - inserting a freshly seeded row if
// this is the first trade the slice has ever seen, otherwise updating the
// existing one in place. `sign` is +1 to apply a trade, -1 to reverse one.
async function upsertSlice(supabase, userId, trade, slice, sign) {
  const existing = await fetchBelief(supabase, userId, slice.sliceKey)
  const r = trade.r_multiple
  const isWin = r > 0
  const isLoss = r < 0

  if (!existing) {
    // Reversing a slice that was never created is a no-op, not an error -
    // it means this trade never actually applied to it (e.g. it predates a
    // dimension existing at all), so there's nothing to undo.
    if (sign < 0) return

    const parent = slice.parentSliceKey ? await fetchBelief(supabase, userId, slice.parentSliceKey) : null
    const seed = seedFromParent(parent)
    const afterR = welfordAdd(seed.avg_r_mean, seed.avg_r_m2, 0, r)
    const afterExpectancy = welfordAdd(seed.expectancy_mean, seed.expectancy_m2, 0, r)

    const { error } = await supabase.from('edge_beliefs').insert([{
      user_id: userId,
      slice_key: slice.sliceKey,
      bindings: slice.bindings,
      parent_slice_key: slice.parentSliceKey,
      win_alpha: seed.win_alpha + (isWin ? 1 : 0),
      win_beta: seed.win_beta + (isLoss ? 1 : 0),
      avg_r_mean: afterR.mean,
      avg_r_m2: afterR.m2,
      expectancy_mean: afterExpectancy.mean,
      expectancy_m2: afterExpectancy.m2,
      n: 1,
      confidence_tier: confidenceTierFor(1),
      recent_outcomes: [outcomeFor(trade)],
      last_trade_at: new Date().toISOString(),
    }])
    if (error) throw error
    return
  }

  const priorRCount = existing.n
  const rUpdate = sign > 0
    ? welfordAdd(existing.avg_r_mean ?? 0, existing.avg_r_m2 ?? 0, priorRCount, r)
    : welfordRemove(existing.avg_r_mean ?? 0, existing.avg_r_m2 ?? 0, priorRCount, r)
  const expectancyUpdate = sign > 0
    ? welfordAdd(existing.expectancy_mean ?? 0, existing.expectancy_m2 ?? 0, priorRCount, r)
    : welfordRemove(existing.expectancy_mean ?? 0, existing.expectancy_m2 ?? 0, priorRCount, r)

  const n = Math.max(0, existing.n + sign)
  const recentOutcomes = sign > 0
    ? [outcomeFor(trade), ...(existing.recent_outcomes || [])].slice(0, RECENT_OUTCOMES_CAP)
    : (existing.recent_outcomes || []).filter((o) => o.trade_id !== trade.id)

  const patch = {
    win_alpha: existing.win_alpha + sign * (isWin ? 1 : 0),
    win_beta: existing.win_beta + sign * (isLoss ? 1 : 0),
    avg_r_mean: rUpdate.mean,
    avg_r_m2: rUpdate.m2,
    expectancy_mean: expectancyUpdate.mean,
    expectancy_m2: expectancyUpdate.m2,
    n,
    confidence_tier: confidenceTierFor(n),
    recent_outcomes: recentOutcomes,
    updated_at: new Date().toISOString(),
  }
  if (sign > 0) {
    patch.last_trade_at = new Date().toISOString()
  } else {
    patch.last_revised_at = new Date().toISOString()
    patch.revision_note = `reversed trade ${trade.id}`
  }

  const { error } = await supabase.from('edge_beliefs').update(patch).eq('id', existing.id)
  if (error) throw error
}

// Fire-and-await from the trade write paths. Both silently no-op for a trade
// with no result yet (r_multiple null) - an open trade hasn't contributed a
// win/loss outcome to believe anything about yet, same as queryPerformance's
// own hasResult filter.
export async function applyTrade(supabase, trade) {
  if (!hasResult(trade)) return
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  for (const slice of slicesForTrade(trade)) {
    await upsertSlice(supabase, user.id, trade, slice, 1)
  }
}

export async function reverseTrade(supabase, trade) {
  if (!hasResult(trade)) return
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  for (const slice of slicesForTrade(trade)) {
    await upsertSlice(supabase, user.id, trade, slice, -1)
  }
}
