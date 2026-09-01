// Shared validation and formatting for the new-trade and edit-trade forms.

export function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === ''
}

// Today as YYYY-MM-DD in the browser's own timezone. Deliberately not
// toISOString(), which is UTC: east of UTC that can still be yesterday, and
// would block the trader from logging a trade dated today.
export function todayDateString() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// Floor for every trade date field - well before any instrument this app
// supports has meaningful history, so it's a sanity backstop against a
// mistyped or misparsed year (e.g. "0201-08-13") rather than a real limit
// traders are expected to hit.
export const MIN_TRADE_DATE = '2010-01-01'

// Every field in the Trade Setup section is mandatory. The form deliberately
// carries no "required" markers, so this returns per-field messages that the
// form renders inline once the user tries to save.
export function validateSetup({ strategyId, trade_date, trade_time, entry, direction, target_distance, stop_distance }) {
  const errors = {}

  if (isBlank(strategyId)) errors.strategy = 'Select a strategy.'

  // The input's min/max attributes only constrain the native picker, and
  // the form sets noValidate, so a typed or pasted out-of-range date has to
  // be caught here. ISO dates compare correctly as strings.
  if (isBlank(trade_date)) {
    errors.trade_date = 'Enter the trade date.'
  } else if (trade_date > todayDateString()) {
    errors.trade_date = 'Trade date cannot be in the future.'
  } else if (trade_date < MIN_TRADE_DATE) {
    errors.trade_date = 'Trade date cannot be before 01/01/2010.'
  }

  if (isBlank(trade_time)) errors.trade_time = 'Enter the entry time.'
  if (isBlank(direction)) errors.direction = 'Choose a direction.'

  if (isBlank(entry)) {
    errors.entry = 'Enter the entry price.'
  } else if (Number.isNaN(parseFloat(entry))) {
    errors.entry = 'Entry price must be a number.'
  }

  if (isBlank(target_distance)) {
    errors.target_distance = 'Enter the take profit distance.'
  } else if (Number.isNaN(parseFloat(target_distance))) {
    errors.target_distance = 'Take profit must be a number.'
  }

  // Stop distance is the denominator for both R:R and R-multiple, so zero
  // has to be rejected here rather than producing an undefined result.
  if (isBlank(stop_distance)) {
    errors.stop_distance = 'Enter the stop loss distance.'
  } else if (Number.isNaN(parseFloat(stop_distance))) {
    errors.stop_distance = 'Stop loss must be a number.'
  } else if (parseFloat(stop_distance) <= 0) {
    errors.stop_distance = 'Stop loss must be greater than 0.'
  }

  return errors
}

// Exit price is the one mandatory field outside Trade Setup: every trade
// has to be closed, so r_multiple can always be derived. The rest of Trade
// Management stays optional.
export function validateExecution({ exit_price, contracts }) {
  const errors = {}

  if (isBlank(exit_price)) {
    errors.exit_price = 'Enter the exit price.'
  } else if (Number.isNaN(parseFloat(exit_price))) {
    errors.exit_price = 'Exit price must be a number.'
  }

  // contracts is optional (a trader may not track position size at all),
  // but a value that's present has to be a real position size - a
  // negative or zero contracts count would otherwise flip the sign of, or
  // zero out, the trade's own $ P&L relative to its R-multiple (see
  // lib/tradeMath.js's calcProfitLoss).
  if (!isBlank(contracts)) {
    const parsed = parseInt(contracts, 10)
    if (Number.isNaN(parsed) || parsed <= 0) {
      errors.contracts = 'Contracts must be a positive whole number.'
    }
  }

  return errors
}

// Discipline works the opposite way from every other mandatory field: there's
// no single blank input to catch, since "unchecked, no tags" is itself a
// valid-looking default. What's actually required is that the trader made a
// choice - either the trade was clean (the checkbox) or they flagged what
// went wrong (at least one tag) - so this only fires when neither happened.
export function validateDiscipline({ reviewedNoIssues, disciplineTags }) {
  const errors = {}
  if (!reviewedNoIssues && (!disciplineTags || disciplineTags.length === 0)) {
    errors.discipline = 'Check "Reviewed — no issues", or select at least one issue below.'
  }
  return errors
}

// The P&L input is shown as currency, so accept anything the formatter can
// have produced ($, thousands separators) and hand back a plain number.
export function parseCurrency(value) {
  if (isBlank(value)) return null
  const cleaned = String(value).replace(/[^0-9.-]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null
  const parsed = parseFloat(cleaned)
  return Number.isNaN(parsed) ? null : parsed
}

export function formatCurrency(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return ''
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Rounds a parsed number to exactly two decimal places and returns it as a
// fixed-scale string ("0.5" -> "0.50"), rather than a JS float, which can't
// hold a trailing zero and would otherwise let the number's stored scale
// drift with whatever precision the typed value or float arithmetic (e.g.
// entry - stopDistance) happened to produce. Postgres's numeric columns
// store text input at face value, so submitting "0.50" keeps that scale in
// the database. Passes null/undefined through unchanged, since Supabase
// treats null as "no value" for optional numeric fields (pnl, contracts).
export function toDecimalString(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null
  return value.toFixed(2)
}
