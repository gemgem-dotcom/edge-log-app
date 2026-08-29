import { hasResult } from './tradeMath'
import { queryPerformance } from './edgeEngine'
import { queryBeliefs } from './queryBeliefs'
import { singleKey, compositeKey, tagKey, tagCrossKey, tagStrategyExtraKey } from './sliceKeys'

// Phase 3 read side - turns the Bayesian posteriors lib/edgeBeliefs.js
// keeps in edge_beliefs into the specific findings each dashboard panel
// shows, rather than each page hand-rolling its own slice-key strings and
// queryBeliefs calls. Three entry points, one per panel depth (see the
// Phase 3 scoping notes): overallFindings (1-way/2-way, All Instruments),
// instrumentFindings (2-way/3-way, per instrument), strategyFindings
// (3-way+, per strategy).
//
// Every finding here is built the same way: use queryPerformance (already
// tested, already the single source of truth for local aggregation) to
// discover which group values exist in the trades actually on screen and
// to rank/sort them, then look up each candidate's own edge_beliefs
// posterior for the number actually displayed. The belief's Bayesian
// pseudo-count blending is what makes a thin slice's win rate/avg R usable
// at all - a 2-way or 3-way composite routinely has a handful of trades,
// where the raw ratio is close to meaningless - so the displayed figure
// should never just be the local queryPerformance row recomputed a second
// time; it should come from the belief whenever one exists. A slice with
// no belief row yet (edge_beliefs hasn't caught up, or predates the
// dimension existing) falls back to the local figure rather than leaving
// the panel blank.

const MIN_TAG_TRADES = 2

// Merges a queryPerformance groupBy result with each row's own belief.
// keyFor maps a row's local key (e.g. an instrument_id, a session label)
// to the slice_key that should carry its Bayesian numbers - null skips the
// belief lookup for that row (the local figures still show).
//
// Both winRate and avgR only use the belief once its OWN confidence_tier
// clears too_early - not just "a belief row exists". A belief seeded from
// only 1-2 real trades is still mostly its parent's prior (PSEUDO_COUNT=10
// phantom weight), which can pull avgR to the opposite sign of the real
// trades it's supposedly summarizing - confirmed live: a strategy's single
// Wednesday loss (-0.9R) rendered as a Bayesian-blended "+0.03R" under an
// "avg loss" column once the parent's own prior was positive enough,
// which reads as a wrong number even though the blend is doing exactly
// what it's designed to. The local, unsmoothed figure is always the
// correct sign for whatever real subset it was computed over, so that's
// the fallback until the slice's own belief has enough real weight behind
// it to trust the smoothed version.
async function withBeliefs(rows, keyFor) {
  const keyed = rows.map((r) => ({ row: r, key: keyFor(r.key) }))
  const beliefs = await queryBeliefs(keyed.map((k) => k.key))
  return keyed.map(({ row, key }) => {
    const belief = key ? beliefs.get(key) : null
    const confident = belief && belief.confidenceTier !== 'too_early'
    return {
      ...row,
      belief,
      winRate: confident && !belief.winRateDegenerate ? belief.winRate : row.winRate,
      avgR: confident ? belief.avgR : row.avgR,
    }
  })
}

function discoverTags(trades) {
  const counts = {}
  for (const t of trades) {
    for (const tag of t.discipline_tags || []) counts[tag] = (counts[tag] || 0) + 1
  }
  return Object.keys(counts)
}

// The tag whose own trades carry the worst local avg R among tags with at
// least MIN_TAG_TRADES occurrences - used only to pick WHICH tag to look
// up a belief for; the number actually shown always comes from that tag's
// belief, not this local ranking pass.
function worstTagCandidate(trades) {
  const tags = discoverTags(trades)
  let worst = null
  for (const tag of tags) {
    const withTag = trades.filter((t) => (t.discipline_tags || []).includes(tag))
    const perf = queryPerformance({ trades: withTag, groupBy: null })
    if (perf.n < MIN_TAG_TRADES || perf.avgR === null) continue
    if (!worst || perf.avgR < worst.avgR) worst = { tag, n: perf.n, avgR: perf.avgR }
  }
  return worst
}

// All Instruments page - 1-way (overall, instrument, session, day,
// discipline) and one 2-way-ish finding (costliest tag, which is itself a
// single-dimension slice, discipline_tag:X, but only exists once a tag has
// been discovered from the raw trades - a genuinely cross-instrument view
// no single instrument's own page could show).
export async function overallFindings(allTrades) {
  const overallBelief = (await queryBeliefs(['overall'])).get('overall')

  const instrumentRows = await withBeliefs(
    queryPerformance({ trades: allTrades, groupBy: 'instrument_id', compareTo: allTrades }),
    (id) => singleKey('instrument_id', id),
  )
  const sessionRows = await withBeliefs(
    queryPerformance({ trades: allTrades, groupBy: 'session', compareTo: allTrades }),
    (v) => singleKey('session', v),
  )
  const dayRows = await withBeliefs(
    queryPerformance({ trades: allTrades, groupBy: 'day_of_week', compareTo: allTrades }),
    (v) => singleKey('day_of_week', v),
  )
  const disciplineRows = await withBeliefs(
    queryPerformance({ trades: allTrades, groupBy: 'discipline', compareTo: allTrades }),
    (v) => singleKey('discipline', v),
  )

  let costliestTag = null
  const worst = worstTagCandidate(allTrades)
  if (worst) {
    const belief = (await queryBeliefs([tagKey(worst.tag)])).get(tagKey(worst.tag))
    costliestTag = { tag: worst.tag, n: worst.n, belief }
  }

  return { overallBelief, instrumentRows, sessionRows, dayRows, disciplineRows, costliestTag }
}

// Per-instrument page - 2-way (instrument x session/day/discipline) plus a
// strategy-comparison table one level deeper (strategy x session, a
// registered 2-way composite in its own right, scoped per strategy active
// on this instrument).
export async function instrumentFindings(instrumentId, instrumentTrades, strategies) {
  const sessionRows = await withBeliefs(
    queryPerformance({ trades: instrumentTrades, groupBy: 'session', compareTo: instrumentTrades }),
    (v) => compositeKey(['instrument_id', 'session'], { instrument_id: instrumentId, session: v }),
  )
  const dayRows = await withBeliefs(
    queryPerformance({ trades: instrumentTrades, groupBy: 'day_of_week', compareTo: instrumentTrades }),
    (v) => compositeKey(['instrument_id', 'day_of_week'], { instrument_id: instrumentId, day_of_week: v }),
  )
  const disciplineRows = await withBeliefs(
    queryPerformance({ trades: instrumentTrades, groupBy: 'discipline', compareTo: instrumentTrades }),
    (v) => compositeKey(['instrument_id', 'discipline'], { instrument_id: instrumentId, discipline: v }),
  )

  // Plain local stats here, not a belief lookup - a strategy belongs to
  // exactly one instrument for its whole life (schema.sql's strategies
  // table: instrument_id not null, unique(instrument_id, name), no
  // reassignment path), so `instrumentTrades` filtered to this strategy is
  // already that strategy's complete history. There is no registered
  // ['strategy_id', 'instrument_id'] composite in lib/edgeEngine.js's
  // COMPOSITE_SLICES (there's no need for one, given the invariant above),
  // so the only belief this could otherwise reach for is strategy_id:X's
  // own global slice - correct in practice today, but only by leaning on
  // an invariant this function has no way to verify, and it would show a
  // silently wrong (too-confident) number the moment that invariant ever
  // stopped holding. Local stats need no such assumption.
  const strategyRows = strategies
    .map((s) => ({ id: s.id, name: s.name, local: queryPerformance({ trades: instrumentTrades.filter((t) => t.strategy_id === s.id), groupBy: null }) }))
    .filter((s) => s.local.n > 0)
    .map((s) => ({ id: s.id, name: s.name, n: s.local.n, confidenceTier: s.local.confidenceTier, winRate: s.local.winRate, avgR: s.local.avgR }))

  return { sessionRows, dayRows, disciplineRows, strategyRows }
}

// Per-strategy page - 3-way+ findings: where (session/day) this strategy's
// losses actually happen, its sharpest mistake tag and when that mistake
// bites, MFE/MAE reframed as stop utilization, time in drawdown, and a
// Bayesian-smoothed $/trade figure - see lib/edgeBeliefs.js's
// hasStrategyBinding comment for why $ is only ever tracked on a
// strategy-linked slice.
export async function strategyFindings(strategyId, strategyTrades) {
  const closedLosses = strategyTrades.filter((t) => hasResult(t) && t.r_multiple < 0)

  const sessionLossRows = await withBeliefs(
    queryPerformance({ trades: closedLosses, groupBy: 'session' }),
    (v) => compositeKey(['strategy_id', 'session', 'outcome'], { strategy_id: strategyId, session: v, outcome: 'loss' }),
  )
  const dayLossRows = await withBeliefs(
    queryPerformance({ trades: closedLosses, groupBy: 'day_of_week' }),
    (v) => compositeKey(['strategy_id', 'day_of_week', 'outcome'], { strategy_id: strategyId, day_of_week: v, outcome: 'loss' }),
  )

  let mistakeTag = null
  const worst = worstTagCandidate(closedLosses)
  if (worst) {
    const withTagLosses = closedLosses.filter((t) => (t.discipline_tags || []).includes(worst.tag))
    const crossKey = tagCrossKey('strategy_id', strategyId, worst.tag)

    // "When" it bites most - rank the real sessions/days this tag's own
    // losses actually occurred in by local avg R, then look up that one
    // slot's own 3-way belief (lib/edgeBeliefs.js's tagStrategyExtraSlices)
    // for the number actually shown.
    const sessionPerf = queryPerformance({ trades: withTagLosses, groupBy: 'session' })
    const dayPerf = queryPerformance({ trades: withTagLosses, groupBy: 'day_of_week' })
    const candidates = [
      ...sessionPerf.map((r) => ({ dim: 'session', value: r.key, n: r.n, avgR: r.avgR })),
      ...dayPerf.map((r) => ({ dim: 'day_of_week', value: r.key, n: r.n, avgR: r.avgR })),
    ].filter((c) => c.n >= MIN_TAG_TRADES && c.avgR !== null)

    let whenKey = null
    let worstWhen = null
    if (candidates.length > 0) {
      worstWhen = candidates.reduce((a, b) => (b.avgR < a.avgR ? b : a))
      whenKey = tagStrategyExtraKey(strategyId, worst.tag, worstWhen.dim, worstWhen.value)
    }

    // Flattened to their own avgR/n here (with a too_early fallback to the
    // local, always-correctly-signed figure, same principle as withBeliefs
    // above) rather than handing the raw belief objects to the caller -
    // confirmed live that skipping this gate lets a 2-real-trade belief's
    // heavy pseudo-count blending flip an actual pair of losses (-1.2R
    // real average) to a displayed "+0.02R", which reads as simply wrong
    // regardless of how defensible the Bayesian math behind it is.
    const beliefs = await queryBeliefs([crossKey, whenKey].filter(Boolean))
    const crossBelief = beliefs.get(crossKey)
    const crossConfident = crossBelief && crossBelief.confidenceTier !== 'too_early'
    const whenBelief = whenKey ? beliefs.get(whenKey) : null
    const whenConfident = whenBelief && whenBelief.confidenceTier !== 'too_early'

    mistakeTag = {
      tag: worst.tag,
      n: crossConfident ? crossBelief.n : worst.n,
      avgR: crossConfident ? crossBelief.avgR : worst.avgR,
      when: worstWhen
        ? {
            label: worstWhen.value,
            n: whenConfident ? whenBelief.n : worstWhen.n,
            avgR: whenConfident ? whenBelief.avgR : worstWhen.avgR,
          }
        : null,
    }
  }

  const stratKey = singleKey('strategy_id', strategyId)
  const stratBelief = (await queryBeliefs([stratKey])).get(stratKey)

  return { sessionLossRows, dayLossRows, mistakeTag, stratBelief }
}
