import { hasResult } from './tradeMath.js'
import { DIMENSIONS, SINGLE_DIMENSIONS, COMPOSITE_SLICES } from './edgeEngine.js'

// CONSTRAINT: scripts/retry-trade-excursions.js dynamically imports this
// file directly (plain Node, outside Next.js's bundler) for
// slicesForTrade/fetchBeliefsByKeys - see the matching comment atop
// lib/edgeEngine.js. Keep this file (and everything it imports)
// framework-free for the same reason.

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

// N-way composite slices (strategy_id x regime, outcome x discipline,
// strategy_id x day_of_week x outcome, ...) - derived from lib/edgeEngine.js's
// COMPOSITE_SLICES the same way, reusing its DIMENSIONS extractors and
// composite key format rather than a second, hand-written builder per
// combination. Only populated when every dimension resolves - a trade with
// a strategy but no regime label yet (or vice versa) is excluded, same
// null-means-not-yet-applicable rule as everywhere else. The new slice's
// prior is always seeded from the same combination with its LAST dimension
// dropped - see COMPOSITE_SLICES' own comment in lib/edgeEngine.js for why
// (a 2-way's parent is dimA's own single-dimension slice, the N=2 case of
// this same rule).
function compositeSlices(trade) {
  const slices = []

  for (const dims of COMPOSITE_SLICES) {
    const sliceKey = DIMENSIONS[dims.join('_x_')](trade)
    if (sliceKey == null) continue
    const values = dims.map((d) => DIMENSIONS[d](trade))
    const bindings = Object.fromEntries(dims.map((d, i) => [d, values[i]]))
    const parentSliceKey = dims.slice(0, -1).map((d, i) => `${d}:${values[i]}`).join('|')
    slices.push({ sliceKey, bindings, parentSliceKey })
  }

  return slices
}

// One slice per individual discipline tag a trade carries - unlike every
// other slice above, this isn't a DIMENSIONS extractor, because a trade
// can belong to MORE than one of these at once. discipline_tags is a
// multi-select (components/TradeForm.js's DISCIPLINE_GROUPS): a trade
// flagged both 'Oversized' and 'Moved stop' contributes to both tag
// slices, not just one - a single-value extractor can't express that, so
// this builds the list directly off the trade's own tags array instead.
// Seeded from discipline:flagged rather than 'overall' - a trade can only
// ever carry a tag when it's already flagged (BASE_DIMENSIONS.discipline's
// own comment covers why reviewed_no_issues/discipline_tags are mutually
// exclusive), so "how do my flagged trades generally look" is a strictly
// more relevant prior than the flat overall average.
function tagSlices(trade) {
  if (!trade.discipline_tags || trade.discipline_tags.length === 0) return []
  return trade.discipline_tags.map((tag) => ({
    sliceKey: `discipline_tag:${tag}`,
    bindings: { discipline_tag: tag },
    parentSliceKey: 'discipline:flagged',
  }))
}

// strategy_id x discipline_tag and instrument_id x discipline_tag - same
// multi-membership rule as tagSlices (a trade with 2 tags contributes to 2
// of these per dimension), but seeded from the strategy's/instrument's own
// single-dimension slice rather than discipline:flagged - "how does this
// specific mistake look within this strategy" is a sharper, more relevant
// starting point than "how do my flagged trades generally look" once
// there's already a strategy or instrument to anchor to. These are also
// the parents the 3-way strategy x tag x <extra> composites below seed
// from.
function tagCrossSlices(trade, dim) {
  const value = DIMENSIONS[dim](trade)
  if (value == null || !trade.discipline_tags || trade.discipline_tags.length === 0) return []
  return trade.discipline_tags.map((tag) => ({
    sliceKey: `${dim}:${value}|discipline_tag:${tag}`,
    bindings: { [dim]: value, discipline_tag: tag },
    parentSliceKey: `${dim}:${value}`,
  }))
}

// strategy_id x discipline_tag x {outcome, session, day_of_week} - one
// layer deeper than tagCrossSlices above: not just "how do Oversized
// trades look on this strategy" but "specifically when they lose" / "on
// this specific day" / "in this specific session". Parent is the 2-way
// strategy_id|discipline_tag slice (dropping the extra dimension), the
// same "drop the last dimension" rule every other composite in this file
// follows. A trade with 2 tags contributes 2 sets of these, same
// multi-membership rule as everywhere else tags are involved.
const TAG_STRATEGY_EXTRA_DIMS = ['outcome', 'session', 'day_of_week']
function tagStrategyExtraSlices(trade) {
  const strategyId = DIMENSIONS.strategy_id(trade)
  if (strategyId == null || !trade.discipline_tags || trade.discipline_tags.length === 0) return []
  const slices = []
  for (const tag of trade.discipline_tags) {
    for (const extraDim of TAG_STRATEGY_EXTRA_DIMS) {
      const extraValue = DIMENSIONS[extraDim](trade)
      if (extraValue == null) continue
      slices.push({
        sliceKey: `strategy_id:${strategyId}|discipline_tag:${tag}|${extraDim}:${extraValue}`,
        bindings: { strategy_id: strategyId, discipline_tag: tag, [extraDim]: extraValue },
        parentSliceKey: `strategy_id:${strategyId}|discipline_tag:${tag}`,
      })
    }
  }
  return slices
}

// outcome x discipline_tag composites - which specific mistakes are
// actually costing you, sharper than outcome x discipline (which only
// answers "you were undisciplined") and sharper than the plain tag slice
// above (which answers "how do my Oversized trades do overall," wins and
// losses blended together). Same multi-membership rule as tagSlices - a
// trade with 2 tags contributes to 2 of these. Seeded from the tag's own
// single-dimension slice (discipline_tag:Oversized) rather than
// outcome:loss - the point of drilling into one specific tag is to refine
// that tag's own number by outcome, not to start over from the generic
// "how do my losses look" baseline. Inherits the same win_alpha/win_beta
// degeneracy warning as every slice_key containing "outcome:" - see
// BASE_DIMENSIONS.outcome in lib/edgeEngine.js.
function tagOutcomeSlices(trade) {
  if (!trade.discipline_tags || trade.discipline_tags.length === 0) return []
  const outcome = DIMENSIONS.outcome(trade)
  return trade.discipline_tags.map((tag) => ({
    sliceKey: `discipline_tag:${tag}|outcome:${outcome}`,
    bindings: { discipline_tag: tag, outcome },
    parentSliceKey: `discipline_tag:${tag}`,
  }))
}

// The full capped slice list for a trade - every slice this trade should
// touch on save/edit/delete. Exported (along with fetchBeliefsByKeys
// below) so scripts/retry-trade-excursions.js can import the real
// slice-membership logic directly rather than keeping its own copy - see
// the CONSTRAINT comment atop lib/edgeEngine.js for what that requires of
// this file and everything it imports.
export function slicesForTrade(trade) {
  return [
    ...singleDimensionSlices(trade),
    ...compositeSlices(trade),
    ...tagSlices(trade),
    ...tagOutcomeSlices(trade),
    ...tagCrossSlices(trade, 'strategy_id'),
    ...tagCrossSlices(trade, 'instrument_id'),
    ...tagStrategyExtraSlices(trade),
  ]
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

// Dollar P&L is only ever tracked for a slice built from strategy_id - R
// is comparable across trades of different position sizes, but raw
// dollars aren't, so averaging them only makes sense once every trade
// contributing shares roughly the same instrument/sizing context, which a
// strategy provides and a bare session or discipline slice doesn't.
// Checking a slice's own bindings rather than hand-listing which slice
// types qualify means every current and future strategy-involving
// composite (2-way or 3-way) picks this up automatically - see
// COMPOSITE_SLICES/tagCrossSlices/tagStrategyExtraSlices above, all of
// which keep strategy_id in their bindings all the way up their parent
// chain except at the strategy_id:X root itself.
function hasStrategyBinding(bindings) {
  return !!bindings && 'strategy_id' in bindings
}

// pnl_mean/pnl_m2/pnl_n - Welford accumulator for trade.pnl, gated by
// hasStrategyBinding and by the trade actually having a dollar figure
// (pnl is an optional field, same as contracts). Own count (pnl_n), not n
// - not every trade in a strategy-linked slice will necessarily have a
// dollar figure. Mirrors avg_r_mean's own two-branch shape exactly:
// pnlSeedFor a brand-new row blends the parent's current pnl_mean in
// weighted by PSEUDO_COUNT alone (the new row has no observations of its
// own yet - only the seed value comes from the parent, not the parent's
// own sample count), while pnlUpdateFor an existing row weights by
// existing.pnl_n + PSEUDO_COUNT, same reasoning as avg_r_mean's
// priorRCount. A parent that was never strategy-linked (the
// strategy_id:X root's own parent, 'overall') never has pnl_mean
// touched, so it's always exactly 0 there - no special-casing needed to
// tell "parent was never eligible" apart from "parent just has no data
// yet," both correctly seed flat via the same `?? 0`.
function pnlSeedFor(bindings, trade, parent) {
  if (!hasStrategyBinding(bindings) || trade.pnl == null) return null
  const result = welfordAdd(parent?.pnl_mean ?? 0, 0, PSEUDO_COUNT, trade.pnl)
  return { pnl_mean: result.mean, pnl_m2: result.m2, pnl_n: 1 }
}

function pnlUpdateFor(existing, trade, sign) {
  if (!hasStrategyBinding(existing.bindings) || trade.pnl == null) return null
  const priorCount = (existing.pnl_n ?? 0) + PSEUDO_COUNT
  const op = sign > 0 ? welfordAdd : welfordRemove
  const result = op(existing.pnl_mean ?? 0, existing.pnl_m2 ?? 0, priorCount, trade.pnl)
  return {
    pnl_mean: result.mean,
    pnl_m2: result.m2,
    pnl_n: Math.max(0, (existing.pnl_n ?? 0) + sign),
  }
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
export async function fetchBeliefsByKeys(supabase, userId, sliceKeys) {
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
    // Blend the seed mean in as PSEUDO_COUNT phantom prior observations,
    // matching how win_alpha/win_beta already treat the seed (10 phantom
    // wins+losses, only slowly shifted by real data) - not count 0, which
    // would make welfordAdd's newMean = mean + (r-mean)/1 = r exactly,
    // discarding the seed's value entirely regardless of what it was. The
    // phantom count only weights this blend; the row's own `n` below still
    // correctly tracks real trades only, starting at 1, not 11.
    const afterR = welfordAdd(seed.avg_r_mean, seed.avg_r_m2, PSEUDO_COUNT, r)
    const afterExpectancy = welfordAdd(seed.expectancy_mean, seed.expectancy_m2, PSEUDO_COUNT, r)
    const pnlSeed = pnlSeedFor(slice.bindings, trade, parent)

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
      ...pnlSeed,
    }
    if (sign > 0) row.last_trade_at = nowIso
    return row
  }

  // The mean/m2 pair was seeded with PSEUDO_COUNT phantom observations
  // already folded in (see the !existing branch above), so the count that
  // correctly backs it is never just the real trade count - it's real count
  // plus that same phantom weight, for exactly as long as this row has
  // existed. Using existing.n alone here would under-weight the prior on
  // every trade after the first (treating an 11-observation blended mean as
  // if it were worth only `existing.n` observations), letting a single new
  // trade swing the mean far more than a Bayesian update should. This also
  // makes reversal exact: removing the slice's last real trade brings the
  // count back down to precisely PSEUDO_COUNT, i.e. the Welford inverse
  // lands back on the untouched seed value instead of collapsing to zero -
  // so a slice that empties out and is later repopulated re-seeds from its
  // parent again rather than starting from a discarded, uninformative mean.
  const priorRCount = existing.n + PSEUDO_COUNT
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
  const pnlUpdate = pnlUpdateFor(existing, trade, sign)

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
    ...pnlUpdate,
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

// MFE/MAE/drawdown, entirely separate from applyTrade/reverseTrade above -
// see the long comment above mfe_r_mean in schema.sql for why (this data
// usually isn't known yet when a trade is first saved, so it can't ride
// along with the trade's own core belief contribution). null unless a
// trade actually has excursion data yet - mfe_points/mae_points are only
// populated once app/api/backfill-trade-excursion/route.js or the hourly
// retry job successfully backfills a trade, and only ever will be for
// NQ-family instruments today. Normalized to an R-multiple (divided by
// the trade's own stop_distance) so it stays comparable across
// instruments, the same convention the trade detail page already uses.
function excursionFor(trade) {
  if (trade.mfe_points == null || trade.mae_points == null || !trade.stop_distance) return null
  return {
    mfeR: trade.mfe_points / trade.stop_distance,
    maeR: trade.mae_points / trade.stop_distance,
    drawdownSeconds: trade.drawdown_seconds ?? 0,
  }
}

// Same shape as seedFromParent above, but for the excursion accumulators -
// kept separate because a parent that has never received real excursion
// data itself (excursion_n still 0) naturally has these fields at their
// column default of 0, which correctly falls back to an uninformative
// seed with no extra branching needed here.
function excursionSeedFromParent(parent) {
  return {
    mfe_r_mean: parent?.mfe_r_mean ?? 0,
    mfe_r_m2: 0,
    mae_r_mean: parent?.mae_r_mean ?? 0,
    mae_r_m2: 0,
    drawdown_seconds_mean: parent?.drawdown_seconds_mean ?? 0,
    drawdown_seconds_m2: 0,
  }
}

// Builds one slice's excursion-only upsert row - null means skip, same
// convention as buildSliceRow. Assumes the slice's core row already exists
// (created by this trade's own earlier applyTrade call) - if it doesn't,
// there's nothing to attach excursion data to, so this is a no-op rather
// than creating a row of its own. Weighted by excursion_n + PSEUDO_COUNT,
// never by n - only some trades in any slice will ever carry this data,
// so it needs its own count entirely (see schema.sql's comment on
// excursion_n for why sharing n would corrupt the Welford weighting for
// every slice member that never gets excursion data at all). The first
// real contribution to a row (excursion_n still 0) seeds from the
// parent's current excursion state instead of this row's own - mirrors
// buildSliceRow's !existing branch, just triggered by excursion_n
// reaching zero rather than the row itself not existing yet.
//
// WARNING - scripts/retry-trade-excursions.js keeps its own duplicate
// copy of this function. Mirror any change here there too - see
// schema.sql's comment above mfe_r_mean for why it's duplicated rather
// than imported. Exported (along with PSEUDO_COUNT below) purely so
// scripts/check-excursion-math-parity.js can call both copies with the
// same inputs and assert they agree - not meant to be used outside that.
export { buildExcursionRow, PSEUDO_COUNT }
function buildExcursionRow(existing, parent, trade, sign, nowIso) {
  if (!existing) return null
  const excursion = excursionFor(trade)
  if (!excursion) return null

  const priorCount = existing.excursion_n ?? 0
  if (sign < 0 && priorCount === 0) return null // nothing to remove

  const source = priorCount === 0
    ? excursionSeedFromParent(parent)
    : {
        mfe_r_mean: existing.mfe_r_mean ?? 0,
        mfe_r_m2: existing.mfe_r_m2 ?? 0,
        mae_r_mean: existing.mae_r_mean ?? 0,
        mae_r_m2: existing.mae_r_m2 ?? 0,
        drawdown_seconds_mean: existing.drawdown_seconds_mean ?? 0,
        drawdown_seconds_m2: existing.drawdown_seconds_m2 ?? 0,
      }

  const weight = priorCount + PSEUDO_COUNT
  const op = sign > 0 ? welfordAdd : welfordRemove
  const mfeUpdate = op(source.mfe_r_mean, source.mfe_r_m2, weight, excursion.mfeR)
  const maeUpdate = op(source.mae_r_mean, source.mae_r_m2, weight, excursion.maeR)
  const drawdownUpdate = op(source.drawdown_seconds_mean, source.drawdown_seconds_m2, weight, excursion.drawdownSeconds)

  return {
    user_id: existing.user_id,
    slice_key: existing.slice_key,
    mfe_r_mean: mfeUpdate.mean,
    mfe_r_m2: mfeUpdate.m2,
    mae_r_mean: maeUpdate.mean,
    mae_r_m2: maeUpdate.m2,
    drawdown_seconds_mean: drawdownUpdate.mean,
    drawdown_seconds_m2: drawdownUpdate.m2,
    excursion_n: Math.max(0, priorCount + sign),
    updated_at: nowIso,
  }
}

// Shared by applyExcursion/reverseExcursion below, mirroring
// applyOrReverse above but for the excursion-only columns. Silently
// no-ops for a trade with no excursion data (excursionFor returns null
// for every slice, so every buildExcursionRow call does too) - callers
// don't need to guard trade.mfe_points themselves before calling this.
//
// Uses trade.user_id directly rather than supabase.auth.getUser() (what
// applyOrReverse above does) - both callers of this function run
// server-side (app/api/backfill-trade-excursion/route.js, the hourly
// retry job), with no logged-in browser session for getUser() to resolve
// against, unlike applyTrade/reverseTrade's browser-only call sites.
// trade.user_id is already the same value getUser() would have returned
// for a trade that authored it, so this isn't a behavior change, just a
// version that works in both contexts.
async function applyOrReverseExcursion(supabase, trade, sign) {
  if (!hasResult(trade)) return
  if (!trade.user_id) return

  const slices = slicesForTrade(trade)
  if (slices.length === 0) return

  const neededKeys = new Set()
  for (const slice of slices) {
    neededKeys.add(slice.sliceKey)
    if (slice.parentSliceKey) neededKeys.add(slice.parentSliceKey)
  }
  const beliefs = await fetchBeliefsByKeys(supabase, trade.user_id, [...neededKeys])

  const nowIso = new Date().toISOString()
  const rows = slices
    .map((slice) => buildExcursionRow(
      beliefs.get(slice.sliceKey),
      slice.parentSliceKey ? beliefs.get(slice.parentSliceKey) : null,
      trade,
      sign,
      nowIso,
    ))
    .filter((row) => row !== null)

  if (rows.length === 0) return

  const { error } = await supabase.from('edge_beliefs').upsert(rows, { onConflict: 'user_id,slice_key' })
  if (error) throw error
}

// Call once a trade's mfe_points/mae_points/drawdown_seconds first become
// real (app/api/backfill-trade-excursion/route.js, scripts/retry-trade-
// excursions.js) - never from the trade save/edit/delete flow, since this
// data usually doesn't exist yet at that point. No-ops cleanly for a
// trade with no excursion data.
export async function applyExcursion(supabase, trade) {
  await applyOrReverseExcursion(supabase, trade, 1)
}

// Call before overwriting a trade's excursion data with a fresh backfill
// (an edit that changed entry/exit invalidates the old MFE/MAE - both
// backfill call sites reverse the pre-edit values before recomputing) or
// when deleting a trade that already had excursion data applied. A no-op
// for a trade that never had excursion data in the first place.
export async function reverseExcursion(supabase, trade) {
  await applyOrReverseExcursion(supabase, trade, -1)
}
