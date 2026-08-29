// Aliased (not a bare relative './supabaseClient') so next.config.js's
// mock-DB webpack plugin - which matches on the literal import-specifier
// string ending in `lib/supabaseClient` - actually catches this import.
// A same-directory relative path from a file that itself lives in lib/
// silently falls through to the REAL client even in dev:mock mode (the
// exact bug already found once this session in lib/queryBeliefs.js -
// confirmed live here too: every getInsight() call returned "Not signed
// in" against the mock DB until this was fixed).
import { supabase } from '@/lib/supabaseClient'

// No automatic regeneration - every Claude call costs real money against
// the trader's own API billing (there's no subscription this rides on
// free), so a panel only ever asks for a fresh insight when the trader
// explicitly clicks Generate/Regenerate. A previous version auto-
// regenerated once a scope picked up a few new trades; removed by
// explicit request in favor of full manual control over spend.

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

// Pure read - whatever's cached for this scope, or nulls if nothing's
// been generated yet. Never calls Claude; the panel decides what to show
// (a "Generate insight" control) when this comes back empty.
export async function getCachedInsight(scope) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { narrative: null, generatedAt: null, error: null }

  const cached = await readCached(user.id, scope)
  return cached
    ? { narrative: cached.narrative, generatedAt: cached.generated_at, error: null }
    : { narrative: null, generatedAt: null, error: null }
}

// The only path that ever calls Claude - triggered exclusively by the
// panel's own Generate/Regenerate control, never automatically.
export async function regenerateInsight(scope, currentTradeCount) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { narrative: null, generatedAt: null, error: 'Not signed in.' }

  try {
    const fresh = await callGenerate(scope, currentTradeCount)
    await writeCached(user.id, scope, fresh)
    return { narrative: fresh.narrative, generatedAt: fresh.generatedAt, error: null }
  } catch (err) {
    // A failed regeneration (rate limit, API outage, missing key) falls
    // back to whatever was already cached rather than wiping out a panel
    // that had something useful to say - the error still surfaces so the
    // trader knows the refresh itself didn't work.
    const cached = await readCached(user.id, scope)
    return {
      narrative: cached?.narrative ?? null,
      generatedAt: cached?.generated_at ?? null,
      error: err.message || 'Could not generate insights.',
    }
  }
}
