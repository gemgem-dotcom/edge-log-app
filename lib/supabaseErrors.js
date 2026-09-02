// Postgres's unique_violation code (stable across versions and locales,
// unlike matching on the message text alone) - see schema.sql's strategies
// table: unique(instrument_id, name) generates a constraint literally named
// strategies_instrument_id_name_key, which a raw duplicate-insert/update
// error quotes verbatim ("duplicate key value violates unique constraint
// \"strategies_instrument_id_name_key\"") - not something a trader has any
// way to act on without translation. Three call sites hit this the same
// way: the sidebar's "+ Add new" (app/app/[instrument]/layout.js),
// TradeForm's own inline add-strategy, and renaming a strategy
// (app/app/[instrument]/strategies/[strategyId]/page.js).
const UNIQUE_VIOLATION_CODE = '23505'
const STRATEGY_NAME_CONSTRAINT = 'strategies_instrument_id_name_key'

export function friendlyStrategyError(error) {
  if (!error) return null
  if (error.code === UNIQUE_VIOLATION_CODE && error.message?.includes(STRATEGY_NAME_CONSTRAINT)) {
    return 'You already have a strategy with this name.'
  }
  return error.message
}
