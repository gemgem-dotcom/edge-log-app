// Shared validation and formatting for the new-trade and edit-trade forms.

export function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === ''
}

// Every field in the Trade Setup section is mandatory. The form deliberately
// carries no "required" markers, so this returns per-field messages that the
// form renders inline once the user tries to save.
export function validateSetup({ strategyId, trade_date, trade_time, entry, direction, target_distance, stop_distance }) {
  const errors = {}

  if (isBlank(strategyId)) errors.strategy = 'Select a strategy.'
  if (isBlank(trade_date)) errors.trade_date = 'Enter the trade date.'
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
// Execution stays optional.
export function validateExecution({ exit_price }) {
  const errors = {}

  if (isBlank(exit_price)) {
    errors.exit_price = 'Enter the exit price.'
  } else if (Number.isNaN(parseFloat(exit_price))) {
    errors.exit_price = 'Exit price must be a number.'
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
