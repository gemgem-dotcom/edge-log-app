import { hasResult } from './tradeMath'
import { DIMENSIONS, SINGLE_DIMENSIONS, COMPOSITE_SLICES } from './edgeEngine'

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
// slice hangs off; it has no parent of its own. Derived from
// lib/edgeEngine.js's SINGLE_DIMENSIONS rather than a hand-written list of
// dimensions here, so a trade belongs to a belief slice exactly when it
// would appear in that dimension's queryPerformance group, and a new
// dimension added there needs no matching edit here.
function singleDimensionSlices(trade) {
  const slices = [{ sliceKey: 'overall', bindings: {}, parentSliceKey: null }]

  for (const dim of SINGLE_DIMENSIONS) {
    const value = DIMENSIONS[dim](trade)
    if (value == null) continue
    slices.push({ sliceKey: `${dim}:${value}`, bindings: { [dim]: value }, parentSliceKey: 'overall' })
  }

  return slices
}

// 2-way composite slices (strategy_id x regime, outcome x discipline, ...) -
// derived from lib/edgeEngine.js's COMPOSITE_SLICES the same way, reusing
// its DIMENSIONS extractors and composite key format rather than a second,
// hand-written builder per pair. Only populated when both halves resolve -
// a trade with a strategy but no regime label yet (or vice versa) is
// excluded, same null-means-not-yet-applicable rule as everywhere else.
// The new slice's prior is always seeded from dimA's own single-dimension
// slice - see COMPOSITE_SLICES' own comment for why that's the more
// informative parent of the two.
function compositeSlices(trade) {
  const slices = []

  for (const [dimA, dimB] of COMPOSITE_SLICES) {
    const sliceKey = DIMENSIONS[`${dimA}_x_${dimB}`](trade)
    if (sliceKey == null) continue
    const valueA = DIMENSIONS[dimA](trade)
    const valueB = DIMENSIONS[dimB](trade)
    slices.push({ sliceKey, bindings: { [dimA]: valueA, [dimB]: valueB }, parentSliceKey: `${dimA}:${valueA}` })
  }

  return slices
}

// The full capped slice list for a trade - every slice this trade should
// touch on save/edit/delete.
function slicesForTrade(trade) {
  return [...singleDimensionSlices(trade), ...compositeSlices(trade)]
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

// One query for every belief row a trade's slices could possibly need -
// each slice's own current row (if it exists) and its parent's (needed to
// seed a brand-new slice) - instead of a separate SELECT per slice. This is
// what turns a trade with ~8 relevant slices from ~8-16 sequential
// round-trips (one or two SELECTs per slice, each awaited before the next
// slice even starts) into exactly one.
async function fetchBeliefsByKeys(supabase, userId, sliceKeys) {
  if (sliceKeys.length === 0) return new Map()
  const { data, error } = await supabase
    .from('edge_beliefs')
    .select('*')
    .eq('user_id', userId)
    .in('slice_key', sliceKeys)
  if (error) throw error
  return new Map(data.map((row) => [row.slice_key, row]))
}

// Builds the exact row to hand to a single batched upsert for one slice -
// null means "skip this slice entirely" (reversing a slice that was never
// created is correctly a no-op, not an error - it means this trade never
// actually applied to it, e.g. it predates a dimension existing at all).
//
// `sign` is +1 to apply a trade, -1 to reverse one, and is the same for
// every slice in one applyTrade/reverseTrade call - which is what lets
// every row this function returns share the same set of columns (only
// last_trade_at for a sign>0 batch, only last_revised_at/revision_note for
// a sign<0 one), a requirement for them to go into one bulk upsert
// statement together. `nowIso` is likewise shared across the whole batch
// rather than each row taking its own timestamp microseconds apart.
function buildSliceRow(userId, trade, slice, sign, existing, parent, nowIso) {
  const r = trade.r_multiple
  const isWin = r > 0
  const isLoss = r < 0

  if (!existing) {
    if (sign < 0) return null

    const seed = seedFromParent(parent)
    const afterR = welfordAdd(seed.avg_r_mean, seed.avg_r_m2, 0, r)
    const afterExpectancy = welfordAdd(seed.expectancy_mean, seed.expectancy_m2, 0, r)

    const row = {
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
      updated_at: nowIso,
    }
    if (sign > 0) row.last_trade_at = nowIso
    return row
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

  const row = {
    user_id: userId,
    slice_key: existing.slice_key,
    bindings: existing.bindings,
    parent_slice_key: existing.parent_slice_key,
    win_alpha: existing.win_alpha + sign * (isWin ? 1 : 0),
    win_beta: existing.win_beta + sign * (isLoss ? 1 : 0),
    avg_r_mean: rUpdate.mean,
    avg_r_m2: rUpdate.m2,
    expectancy_mean: expectancyUpdate.mean,
    expectancy_m2: expectancyUpdate.m2,
    n,
    confidence_tier: confidenceTierFor(n),
    recent_outcomes: recentOutcomes,
    updated_at: nowIso,
  }
  if (sign > 0) {
    row.last_trade_at = nowIso
  } else {
    row.last_revised_at = nowIso
    row.revision_note = `reversed trade ${trade.id}`
  }
  return row
}

// Shared by applyTrade/reverseTrade below - sign is the only difference
// between the two. Both silently no-op for a trade with no result yet
// (r_multiple null), same as queryPerformance's own hasResult filter.
//
// One SELECT (every slice this trade touches, plus their parents, in one
// query) followed by one bulk upsert (every row this trade's slices
// resolve to, keyed on the table's existing unique(user_id, slice_key)
// constraint) - two round-trips total regardless of how many slices a
// trade participates in, replacing what was previously one or two
// sequential round-trips *per slice*. The bulk upsert is also strictly
// more atomic than the old per-slice loop: a single multi-row INSERT runs
// as one statement, so a failure can no longer leave a trade half-applied
// across some belief slices but not others.
//
// Minor, deliberate behavior note: seeding a brand-new slice now always
// uses its parent's state from *before* this trade's own contribution,
// even when the parent is also being freshly created by this same trade
// (e.g. a user's very first-ever trade, where 'overall' and one of its
// children are both new at once). The previous sequential version's
// seed could vary depending on array order (a slice processed after its
// parent would see the parent already updated by this same trade) - this
// is a narrow edge case (first trade ever in a brand-new slice) and the
// new behavior is the more principled one, not a regression.
async function applyOrReverse(supabase, trade, sign) {
  if (!hasResult(trade)) return
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  const slices = slicesForTrade(trade)
  if (slices.length === 0) return

  const neededKeys = new Set()
  for (const slice of slices) {
    neededKeys.add(slice.sliceKey)
    if (slice.parentSliceKey) neededKeys.add(slice.parentSliceKey)
  }
  const beliefs = await fetchBeliefsByKeys(supabase, user.id, [...neededKeys])

  const nowIso = new Date().toISOString()
  const rows = slices
    .map((slice) => buildSliceRow(
      user.id,
      trade,
      slice,
      sign,
      beliefs.get(slice.sliceKey),
      slice.parentSliceKey ? beliefs.get(slice.parentSliceKey) : null,
      nowIso,
    ))
    .filter((row) => row !== null)

  if (rows.length === 0) return

  const { error } = await supabase.from('edge_beliefs').upsert(rows, { onConflict: 'user_id,slice_key' })
  if (error) throw error
}

export async function applyTrade(supabase, trade) {
  await applyOrReverse(supabase, trade, 1)
}

export async function reverseTrade(supabase, trade) {
  await applyOrReverse(supabase, trade, -1)
}
