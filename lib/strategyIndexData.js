import { supabase } from '@/lib/supabaseClient'
import { fetchAllRows } from './fetchAllRows'

// Everything the strategies index needs, as one call that RETURNS data
// rather than setting it.
//
// Kept out of the page for two reasons. It is the shape the
// react-hooks/set-state-in-effect rule actually asks for - an effect that
// subscribes to an external system and sets state in the callback, rather
// than an effect that calls a function which setStates synchronously - so
// the page costs this repo's lint ratchet nothing. And a function that
// takes a symbol and returns rows is testable, which the same logic
// inlined in a component is not.
//
// Never throws: every failure comes back as { error } so the caller has
// one shape to handle.
export async function loadStrategyIndex(symbol) {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) return { error: 'no-session' }

    const { data: instrument } = await supabase
      .from('instruments').select('*')
      .eq('user_id', user.id).eq('symbol', symbol).eq('archived', false).single()
    if (!instrument) return { error: 'no-instrument' }

    const { data: strategies, error: stratError } = await supabase
      .from('strategies').select('*')
      .eq('instrument_id', instrument.id).order('created_at', { ascending: true })
    if (stratError) return { error: 'failed' }

    // Every trade, not a page. These are whole-history stats and
    // PostgREST silently caps an unbounded select at 1000 rows, so a
    // plain select would under-count a busy journal with no error to say
    // so - see fetchAllRows.
    // { data, error }, not a bare array - fetchAllRows keeps Supabase's
    // own result shape.
    const { data: trades, error: tradeError } = await fetchAllRows((from, to) =>
      supabase.from('trades').select('*')
        .eq('instrument_id', instrument.id)
        .order('trade_date', { ascending: true })
        .range(from, to))
    if (tradeError) return { error: 'failed' }

    return { instrument, strategies: strategies || [], trades: trades || [] }
  } catch {
    return { error: 'failed' }
  }
}

// Message for each error code loadStrategyIndex can return, so the page
// does not hand a raw code to a user.
export const STRATEGY_INDEX_ERRORS = {
  'no-session': 'your session has expired. Sign in again.',
  'no-instrument': 'that instrument could not be found.',
  failed: 'something went wrong.',
}

// The same thing at scope "All instruments".
//
// This exists because the Strategies tab has to work on the three screens
// that have no instrument in view. Without it that tab fell back to /app -
// the same URL the Overview tab already resolves to - so two of five tabs
// pointed at one page and Strategies was, in effect, dead. (The unit test
// in lib/mobileTabs.test.js now asserts no two tabs can share a URL.)
//
// Each row carries its own instrument symbol, because a strategy id only
// means anything under the instrument that owns it - the same reason the
// all-instruments trade log resolves each row's symbol rather than using
// a page-level one.
export async function loadAllStrategies() {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    if (!user) return { error: 'no-session' }

    const { data: instruments } = await supabase
      .from('instruments').select('*')
      .eq('user_id', user.id).eq('archived', false)
      .order('created_at', { ascending: true })
    const list = instruments || []
    if (list.length === 0) return { instruments: [], strategies: [], trades: [] }

    const ids = list.map((i) => i.id)
    const { data: strategies, error: stratError } = await supabase
      .from('strategies').select('*')
      .in('instrument_id', ids).order('created_at', { ascending: true })
    if (stratError) return { error: 'failed' }

    const { data: trades, error: tradeError } = await fetchAllRows((from, to) =>
      supabase.from('trades').select('*')
        .in('instrument_id', ids)
        .order('trade_date', { ascending: true })
        .range(from, to))
    if (tradeError) return { error: 'failed' }

    return { instruments: list, strategies: strategies || [], trades: trades || [] }
  } catch {
    return { error: 'failed' }
  }
}
