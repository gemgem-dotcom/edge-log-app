// Postgres's unique_violation code (stable across versions and locales,
// unlike matching on the message text alone) - see schema.sql's unique(...)
// constraints on strategies (instrument_id, name) and instruments (user_id,
// symbol), which generate constraints literally named
// strategies_instrument_id_name_key / instruments_user_id_symbol_key. A raw
// duplicate-insert/update error quotes one of these verbatim ("duplicate
// key value violates unique constraint \"...\"") - not something a trader
// has any way to act on without translation.
//
// The fallback for every other kind of error is a fixed generic message,
// not error.message - any Supabase/Postgres failure (RLS denial, a network
// blip, a genuinely unexpected exception) is just as unhelpful to show raw,
// and there's no complete list of "safe" ones worth maintaining.
const UNIQUE_VIOLATION_CODE = '23505'
const STRATEGY_NAME_CONSTRAINT = 'strategies_instrument_id_name_key'
const INSTRUMENT_SYMBOL_CONSTRAINT = 'instruments_user_id_symbol_key'
const GENERIC_MESSAGE = 'Something went wrong. Please try again.'

// Strategy add (app/app/[instrument]/layout.js, TradeForm's own inline
// add-strategy) and rename (strategies/[strategyId]/page.js).
export function friendlyStrategyError(error) {
  if (!error) return null
  if (error.code === UNIQUE_VIOLATION_CODE && error.message?.includes(STRATEGY_NAME_CONSTRAINT)) {
    return 'You already have a strategy with this name.'
  }
  return GENERIC_MESSAGE
}

// Instrument add (components/InstrumentNav.js's addOrRestoreInstrument
// call) - addOrRestoreInstrument already checks for an existing row first
// and restores it instead of inserting, so this constraint should only
// ever actually fire under a genuine race (e.g. a rapid double-submit).
export function friendlyInstrumentError(error) {
  if (!error) return null
  if (error.code === UNIQUE_VIOLATION_CODE && error.message?.includes(INSTRUMENT_SYMBOL_CONSTRAINT)) {
    return 'You already added this instrument.'
  }
  return GENERIC_MESSAGE
}
