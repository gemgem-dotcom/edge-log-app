// How many paid Claude calls an account may make, and how often.
//
// WHY THIS REPLACED WHAT WAS HERE. The route used to read
// `edge_insights.generated_at` and refuse if it was less than a minute
// old. Its own comment called that "the only server-side defense
// against runaway Claude spend". It defended nothing, for two reasons
// that compound:
//
//   1. The route never WRITES edge_insights. The browser does, in
//      lib/insightsClient.js. A caller that simply never writes has no
//      row, so the cooldown branch is skipped and every request
//      reaches the model.
//   2. Even with a row, it is the caller's own row under a `for all`
//      policy. One PATCH through PostgREST with the public anon key
//      sets generated_at back to 2000 and the cooldown is gone.
//
// So the limiter was keyed on state the attacker owned. Anyone who can
// sign up - signup is open - could loop the endpoint and bill the
// owner's Anthropic key without limit.
//
// The state now lives in `insight_call`, a table with row level
// security on and NO policies, so only the service role can read or
// write it. The row is written BEFORE the model is called, which is
// the same claim-not-check shape `econ_refresh_lock` already uses in
// this repo: checking first and acting second lets a burst of parallel
// requests all see the same clear state and all proceed.

// One paid call per scope per minute. Generous for a deliberate,
// occasional click; useless to a loop.
export const MIN_INTERVAL_MS = 60 * 1000

// And a ceiling across every scope, because the per-scope interval
// alone is multiplied by however many scopes an account can invent -
// one per instrument and one per strategy, all of which the caller
// creates themselves. Fifty is far above any real day's use and still
// bounds the worst case to something survivable.
export const MAX_CALLS_PER_DAY = 50
export const DAY_MS = 24 * 60 * 60 * 1000

// Decide from the account's recent calls, INCLUDING the one just
// recorded. Pure, so the policy can be tested without a database and
// the route stays a thin caller.
//
// Rows are { scope, created_at }; order is not assumed.
export function spendVerdict(rows, { scope, now = Date.now() } = {}) {
  const recent = (rows || [])
    .filter((r) => r && Number.isFinite(new Date(r.created_at).getTime()))

  const today = recent.filter((r) => new Date(r.created_at).getTime() > now - DAY_MS)
  if (today.length > MAX_CALLS_PER_DAY) {
    return {
      allowed: false,
      reason: 'daily',
      message: "You've reached today's limit for regenerating insights. It resets in a few hours.",
    }
  }

  // Everything for this scope except the row just written - that one is
  // this request, and a request cannot be too soon after itself.
  const sameScope = today
    .filter((r) => r.scope === scope)
    .map((r) => new Date(r.created_at).getTime())
    .sort((a, b) => b - a)
  const previous = sameScope[1]

  if (previous !== undefined && now - previous < MIN_INTERVAL_MS) {
    const waitSeconds = Math.max(1, Math.ceil((MIN_INTERVAL_MS - (now - previous)) / 1000))
    return {
      allowed: false,
      reason: 'interval',
      message: `Please wait ${waitSeconds}s before regenerating this again.`,
    }
  }

  return { allowed: true, reason: null, message: null }
}

// The continuity text handed to the model.
//
// This used to come off the request body, which meant the caller wrote
// part of the SYSTEM prompt: the fence around it is three quote marks,
// and a caller can close it and write fresh instructions. That turned
// the owner's Anthropic key into an open, unlogged LLM proxy, with the
// resulting content attributable to their organisation.
//
// The previous narrative is already in the database, and the route
// already queries that table for the spend check, so there is no
// reason to take the caller's word for it. This only ever sees a
// string the server stored.
//
// Still capped: a stored narrative is bounded by what the model
// produced last time, but a bound that exists only by convention is
// not a bound.
export const MAX_CONTINUITY_CHARS = 8000

export function continuityFrom(storedNarrative) {
  if (typeof storedNarrative !== 'string') return null
  const trimmed = storedNarrative.trim()
  if (!trimmed) return null
  return trimmed.slice(0, MAX_CONTINUITY_CHARS)
}
