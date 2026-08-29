import { COMPOSITE_SLICES } from './edgeEngine'

// Slice-key builders for the read side (dashboard panels) - construct the
// exact same slice_key strings lib/edgeBeliefs.js writes to edge_beliefs
// (see its own header comment and the long comment above `create table
// edge_beliefs` in schema.sql for the format), so a panel can look up a
// specific slice via lib/queryBeliefs.js without hand-interpolating that
// format a second time per call site. Every builder returns null on
// missing input rather than a malformed key - callers filter nulls out
// before querying, same "not yet applicable" convention as
// lib/edgeEngine.js's DIMENSIONS extractors.

export function singleKey(dim, value) {
  return value == null ? null : `${dim}:${value}`
}

// Throws if `dims` isn't one of lib/edgeEngine.js's registered
// COMPOSITE_SLICES entries - catches an order/typo mistake (e.g. asking
// for ['session', 'strategy_id'] when only ['strategy_id', 'session'] is
// ever written) at the call site, instead of silently building a
// slice_key nothing in edge_beliefs will ever match.
function assertRegisteredComposite(dims) {
  const match = COMPOSITE_SLICES.some((c) => c.length === dims.length && c.every((d, i) => d === dims[i]))
  if (!match) {
    throw new Error(`sliceKeys.compositeKey: [${dims.join(', ')}] is not in lib/edgeEngine.js's COMPOSITE_SLICES`)
  }
}

// dims: e.g. ['strategy_id', 'session']. values: { strategy_id: 'uuid', session: 'London session' }.
export function compositeKey(dims, values) {
  assertRegisteredComposite(dims)
  if (dims.some((d) => values[d] == null)) return null
  return dims.map((d) => `${d}:${values[d]}`).join('|')
}

// discipline_tag:<tag> - lib/edgeBeliefs.js's tagSlices.
export function tagKey(tag) {
  return tag ? `discipline_tag:${tag}` : null
}

// <dim>:<value>|discipline_tag:<tag> - lib/edgeBeliefs.js's tagCrossSlices,
// dim is 'strategy_id' or 'instrument_id'.
export function tagCrossKey(dim, value, tag) {
  return (value == null || !tag) ? null : `${dim}:${value}|discipline_tag:${tag}`
}

// strategy_id:<id>|discipline_tag:<tag>|<extraDim>:<extraValue> -
// lib/edgeBeliefs.js's tagStrategyExtraSlices, extraDim one of
// 'outcome'/'session'/'day_of_week'.
export function tagStrategyExtraKey(strategyId, tag, extraDim, extraValue) {
  return (!strategyId || !tag || extraValue == null)
    ? null
    : `strategy_id:${strategyId}|discipline_tag:${tag}|${extraDim}:${extraValue}`
}

// discipline_tag:<tag>|outcome:<outcome> - lib/edgeBeliefs.js's tagOutcomeSlices.
export function tagOutcomeKey(tag, outcome) {
  return (!tag || !outcome) ? null : `discipline_tag:${tag}|outcome:${outcome}`
}
