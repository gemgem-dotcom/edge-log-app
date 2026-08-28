import { supabase } from './supabaseClient'
import { catalogEntryFor } from './instrumentCatalog'
import { invalidateInstruments } from './referenceDataCache'

// Adds `symbol` for this user, or - if they'd previously removed it (see
// InstrumentMenu.js) - un-archives that same row instead of inserting a
// new one, so its trades/strategies (still pointing at the same
// instrument_id) come back exactly as they were. unique(user_id, symbol)
// means there's only ever one row per symbol per user regardless of
// archived state, so a plain insert would fail once a symbol has been
// added before. Same call site both onboarding (app/app/page.js) and the
// topbar "+ Add instrument" (InstrumentNav.js) share - "add" always means
// this, whether the symbol is brand new or coming back from removed.
//
// `restored` tells the caller which happened - onboarding uses it to skip
// force-creating a "first strategy" on a restore, since the instrument's
// old strategies are already coming back with it and re-adding one under
// the same name would hit strategies' own unique(instrument_id, name).
export async function addOrRestoreInstrument(userId, symbol) {
  const { data: existing } = await supabase
    .from('instruments')
    .select('*')
    .eq('user_id', userId)
    .eq('symbol', symbol)
    .single()

  if (existing) {
    const result = await supabase
      .from('instruments')
      .update({ archived: false })
      .eq('id', existing.id)
      .select()
      .single()
    invalidateInstruments()
    return { ...result, restored: true }
  }

  const catalogEntry = catalogEntryFor(symbol)
  const result = await supabase
    .from('instruments')
    .insert([{
      user_id: userId,
      symbol,
      data_symbol: catalogEntry?.data_symbol || symbol,
      display_name: catalogEntry?.display_name || null,
    }])
    .select()
    .single()
  invalidateInstruments()
  return { ...result, restored: false }
}
