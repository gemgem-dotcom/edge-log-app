// Fire-and-forget trigger for server-side MFE/MAE/drawdown computation
// (app/api/backfill-trade-excursion/route.js) - called from the trade
// save/edit flows right after a successful write. Never awaited by its
// callers for anything user-visible; a failure here shouldn't surface to
// the trader, since the hourly retry job (scripts/retry-trade-excursions.js)
// will catch anything this attempt missed once the trade is old enough.
import { supabase } from './supabaseClient'
import { catalogEntryFor } from './instrumentCatalog'

export async function requestTradeExcursionBackfill(symbol, tradeId) {
  // Only NQ-family instruments have a Databento symbol resolved anywhere in
  // this app - skip the request client-side rather than making a call the
  // route would just reject, same pattern lib/tradeRegimes.js and
  // lib/todaysBrief.js already follow before doing Databento-related work.
  if (catalogEntryFor(symbol)?.data_symbol !== 'NQ') return

  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return
    await fetch('/api/backfill-trade-excursion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ tradeId }),
    })
  } catch {
    // Best-effort - see file header.
  }
}
