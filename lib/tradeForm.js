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

  // Same `> 0` rule as stop_distance below, which this was missing. Both
  // are distances from entry, and direction alone decides which side of it
  // they land on (calcTargetPrice adds for a long, subtracts for a short) -
  // so a negative distance silently puts the take profit on the losing side
  // of entry. A long at 21050 with target_distance -30 stored target 21020,
  // displayed a planned R:R of -2.00, and made inferOutcome report "Hit
  // target" for any exit above 21020 - including a 5-point scrape. Zero is
  // rejected for the same reason it is on the stop: a target at entry is
  // not a target.
  if (isBlank(target_distance)) {
    errors.target_distance = 'Enter the take profit distance.'
  } else if (Number.isNaN(parseFloat(target_distance))) {
    errors.target_distance = 'Take profit must be a number.'
  } else if (parseFloat(target_distance) <= 0) {
    errors.target_distance = 'Take profit must be greater than 0.'
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

// Exit time and exit price are both mandatory for the primary exit: every
// trade has to be closed, so r_multiple can always be derived, and a real
// exit instant is what excursionWindow (lib/tradeExcursions.js) needs to
// build a Databento search window at all - a blank exit time isn't filled
// in from market data later, it just leaves the trade permanently
// unmatched (see excursionWindow's own comment). Contracts and $ P&L stay
// optional.
export function validateExecution({ exit_time, exit_price, contracts }) {
  const errors = {}

  if (isBlank(exit_time)) errors.exit_time = 'Enter the exit time.'

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

// Same exit_time/exit_price requirement as the primary exit (see
// validateExecution above), applied to one row of a multi-exit ("Custom"
// outcome) trade - except a row the trader added via "+ Add another exit"
// and then left completely untouched, which handleSubmit already drops
// before saving rather than storing as an empty leg (see its own comment
// there). Validating that row would block a save over a click the trader
// may not even remember making, so a row with all three fields still
// blank returns no errors here, matching what actually gets saved.
export function validateAdditionalExit({ exit_time, exit_price, contracts }) {
  const errors = {}
  if (isBlank(exit_time) && isBlank(exit_price) && isBlank(contracts)) return errors

  if (isBlank(exit_time)) errors.exit_time = 'Enter the exit time.'

  if (isBlank(exit_price)) {
    errors.exit_price = 'Enter the exit price.'
  } else if (Number.isNaN(parseFloat(exit_price))) {
    errors.exit_price = 'Exit price must be a number.'
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
