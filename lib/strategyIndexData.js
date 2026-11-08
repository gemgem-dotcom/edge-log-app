import { supabase } from '@/lib/supabaseClient'
import { fetchAllRows } from './fetchAllRows'
import { getInstruments } from './referenceDataCache'
import { writeTrades, onTradesInvalidated } from './tradesCache'

// These two loaders each ran three round-trips strictly one after another:
// instruments, then strategies, then every trade. Measured on a throttled
// phone that was 1.2-1.4s of skeleton on EVERY visit to the Strategies tab.
//
// Only the first is a real dependency - the other two both need nothing
// but the instrument ids, so they now run concurrently, and the
// instruments themselves come from the cache the sidebar has already
// filled. What is left is one round-trip's worth of waiting instead of
// three.
//
// The trades are cached under their own variant, because this query orders
// by trade_date and the Overview's orders by id over the same instruments
// - see tradesKey's comment on why that distinction is not optional.
const TRADES_VARIANT = 'by-date'

// Last-known result per scope, so returning to the Strategies tab paints
// immediately instead of showing a skeleton for the length of a
// whole-history trades query. Stale-while-revalidate, exactly as
// lib/tradesCache.js describes: the peek seeds the first render, the real
// load runs regardless and replaces it, so anything stale self-corrects
// within one request rather than persisting until a reload.
//
// CLEARED ON SIGN-OUT, which is not optional. These rows are one user's
// strategies and trades, held in a module variable with no user id on it -
// the same hazard peekReferenceData has, and it is safe for the same
// reason: app/app/layout.js's onAuthStateChange clears this alongside the
// reference-data cache on every sign-out and session-expiry path, so a
// second user on the same tab can never peek the first user's journal.
const peeked = new Map() // scope key -> { instrument?, instruments?, strategies, trades }

// These results contain trades, so any write to `trades` makes them stale
// - see onTradesInvalidated's comment in lib/tradesCache.js.
onTradesInvalidated(() => peeked.clear())
const ALL = '__all__'

export function peekStrategyIndex(symbol) {
  return peeked.get(symbol) || null
}

export function peekAllStrategies() {
  return peeked.get(ALL) || null
}

export function clearStrategyIndexCache() {
  peeked.clear()
}

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

    // Concurrently: neither needs the other, only instrument.id.
    //
    // Every trade, not a page. These are whole-history stats and
    // PostgREST silently caps an unbounded select at 1000 rows, so a
    // plain select would under-count a busy journal with no error to say
    // so - see fetchAllRows.
    // { data, error }, not a bare array - fetchAllRows keeps Supabase's
    // own result shape.
    const [
      { data: strategies, error: stratError },
      { data: trades, error: tradeError },
    ] = await Promise.all([
      supabase.from('strategies').select('*')
        .eq('instrument_id', instrument.id).order('created_at', { ascending: true }),
      fetchAllRows((from, to) =>
        supabase.from('trades').select('*')
          .eq('instrument_id', instrument.id)
          .order('trade_date', { ascending: true })
          .range(from, to)),
    ])
    if (stratError) return { error: 'failed' }
    if (tradeError) return { error: 'failed' }
    writeTrades([instrument.id], trades || [], TRADES_VARIANT)

    const result = { instrument, strategies: strategies || [], trades: trades || [] }
    peeked.set(symbol, result)
    return result
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

    // Same query the sidebar already ran, so on any navigation within /app
    // this is a cache hit and costs nothing. Every write to `instruments`
    // invalidates it - see referenceDataCache's own comment.
    const list = await getInstruments(supabase, user.id)
    if (list.length === 0) return { instruments: [], strategies: [], trades: [] }

    const ids = list.map((i) => i.id)
    const [
      { data: strategies, error: stratError },
      { data: trades, error: tradeError },
    ] = await Promise.all([
      supabase.from('strategies').select('*')
        .in('instrument_id', ids).order('created_at', { ascending: true }),
      fetchAllRows((from, to) =>
        supabase.from('trades').select('*')
          .in('instrument_id', ids)
          .order('trade_date', { ascending: true })
          .range(from, to)),
    ])
    if (stratError) return { error: 'failed' }
    if (tradeError) return { error: 'failed' }
    writeTrades(ids, trades || [], TRADES_VARIANT)

    const result = { instruments: list, strategies: strategies || [], trades: trades || [] }
    peeked.set(ALL, result)
    return result
  } catch {
    return { error: 'failed' }
  }
}
