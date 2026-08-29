// Aliased (not a bare relative './supabaseClient') so next.config.js's
// mock-DB webpack plugin - which matches on the literal import-specifier
// string ending in `lib/supabaseClient` - actually catches this import.
// A same-directory relative path from a file that itself lives in lib/
// silently falls through to the REAL client even in dev:mock mode (the
// exact bug already found once this session in lib/queryBeliefs.js -
// confirmed live here too: every getInsight() call returned "Not signed
// in" against the mock DB until this was fixed).
import { supabase } from '@/lib/supabaseClient'

// How many NEW closed trades a scope needs to have picked up since its
// last generation before it's worth spending another Claude call on -
// the hybrid regeneration policy: pages read the cached narrative
// instantly (no LLM round-trip in the page-load path), and only pay for a
// fresh one when there's actually enough new information to plausibly
// change what it says. A scope with no cached row yet is always
// generated once, regardless of trade count (even 1 trade is worth a
// first pass).
const REGEN_THRESHOLD = 3

async function readCached(userId, scope) {
  const { data } = await supabase.from('edge_insights').select('*').eq('user_id', userId).eq('scope', scope).single()
  return data || null
}

async function writeCached(userId, scope, { narrative, generatedAt, tradeCount }) {
  // Real Supabase accepts either a single row or an array for .upsert(),
  // but always pass an array here - both the mock client and this app's
  // other .upsert() call sites (lib/edgeBeliefs.js) only ever handle one.
  await supabase.from('edge_insights').upsert(
    [{ user_id: userId, scope, narrative, generated_at: generatedAt, trade_count_at_generation: tradeCount }],
    { onConflict: 'user_id,scope' },
  )
}

async function callGenerate(scope, tradeCount) {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  const res = await fetch('/api/generate-insights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ scope, tradeCount }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Request failed (${res.status})`)
  }
  return res.json()
}

// Reads the cached insight for this scope, and - only if it's missing or
// stale enough (REGEN_THRESHOLD new trades since it was generated) -
// requests, caches, and returns a fresh one instead. currentTradeCount is
// the caller's own already-loaded trade count for this scope, so this
// needs no extra round trip just to decide staleness.
export async function getInsight(scope, currentTradeCount) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { narrative: null, generatedAt: null, error: 'Not signed in.' }

  const cached = await readCached(user.id, scope)
  const stale = !cached || (currentTradeCount - cached.trade_count_at_generation) >= REGEN_THRESHOLD
  if (!stale) {
    return { narrative: cached.narrative, generatedAt: cached.generated_at, error: null }
  }

  try {
    const fresh = await callGenerate(scope, currentTradeCount)
    await writeCached(user.id, scope, fresh)
    return { narrative: fresh.narrative, generatedAt: fresh.generatedAt, error: null }
  } catch (err) {
    // A failed regeneration (rate limit, API outage, missing key) falls
    // back to whatever's already cached rather than blanking a panel that
    // had something useful to say - only a genuinely first-ever
    // generation with nothing cached surfaces the error itself.
    if (cached) return { narrative: cached.narrative, generatedAt: cached.generated_at, error: null }
    return { narrative: null, generatedAt: null, error: err.message || 'Could not generate insights.' }
  }
}

// Explicit user-triggered regeneration (the "Regenerate" control) -
// always calls through regardless of the staleness threshold above.
export async function regenerateInsight(scope, currentTradeCount) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { narrative: null, generatedAt: null, error: 'Not signed in.' }

  try {
    const fresh = await callGenerate(scope, currentTradeCount)
    await writeCached(user.id, scope, fresh)
    return { narrative: fresh.narrative, generatedAt: fresh.generatedAt, error: null }
  } catch (err) {
    return { narrative: null, generatedAt: null, error: err.message || 'Could not generate insights.' }
  }
}
