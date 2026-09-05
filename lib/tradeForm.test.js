import { describe, it, expect } from 'vitest'
import { validateSetup, validateExecution, validateAdditionalExit } from './tradeForm'

// A valid setup, so each case below changes exactly one field. The date is
// fixed and in the past - validateSetup rejects a future trade_date, so a
// relative date here would start failing on its own one day.
const SETUP = {
  strategyId: 's1',
  direction: 'long',
  trade_date: '2026-03-02',
  trade_time: '09:30',
  entry: '21050',
  stop_distance: '10',
  target_distance: '30',
}

describe('validateSetup', () => {
  it('accepts a complete setup', () => {
    expect(validateSetup(SETUP)).toEqual({})
  })

  it('requires each field', () => {
    expect(validateSetup({ ...SETUP, strategyId: '' })).toHaveProperty('strategy')
    expect(validateSetup({ ...SETUP, direction: '' })).toHaveProperty('direction')
    expect(validateSetup({ ...SETUP, trade_date: '' })).toHaveProperty('trade_date')
    expect(validateSetup({ ...SETUP, trade_time: '' })).toHaveProperty('trade_time')
    expect(validateSetup({ ...SETUP, entry: '' })).toHaveProperty('entry')
    expect(validateSetup({ ...SETUP, stop_distance: '' })).toHaveProperty('stop_distance')
    expect(validateSetup({ ...SETUP, target_distance: '' })).toHaveProperty('target_distance')
  })

  it('rejects non-numeric prices and distances', () => {
    expect(validateSetup({ ...SETUP, entry: 'abc' })).toHaveProperty('entry')
    expect(validateSetup({ ...SETUP, stop_distance: 'abc' })).toHaveProperty('stop_distance')
    expect(validateSetup({ ...SETUP, target_distance: 'abc' })).toHaveProperty('target_distance')
  })

  // Both are distances from entry, and direction alone decides which side
  // they land on - so a non-positive distance silently puts the level on the
  // wrong side of entry rather than failing. target_distance used to be
  // checked only for NaN: a -30 target stored a "take profit" BELOW entry on
  // a long, showed a planned R:R of -2.00, and made the form report "Hit
  // target" for a 5-point scrape.
  it('rejects a non-positive stop distance', () => {
    expect(validateSetup({ ...SETUP, stop_distance: '0' })).toHaveProperty('stop_distance')
    expect(validateSetup({ ...SETUP, stop_distance: '-10' })).toHaveProperty('stop_distance')
  })

  it('rejects a non-positive take profit distance', () => {
    expect(validateSetup({ ...SETUP, target_distance: '0' })).toHaveProperty('target_distance')
    expect(validateSetup({ ...SETUP, target_distance: '-30' })).toHaveProperty('target_distance')
  })

  it('accepts fractional distances (GC/CL trade in 0.1s)', () => {
    expect(validateSetup({ ...SETUP, entry: '2387.4', stop_distance: '0.5', target_distance: '1.5' })).toEqual({})
  })
})

describe('validateExecution', () => {
  it('requires exit time and exit price', () => {
    const errors = validateExecution({ exit_time: '', exit_price: '', contracts: '' })
    expect(errors.exit_time).toBe('Enter the exit time.')
    expect(errors.exit_price).toBe('Enter the exit price.')
  })

  it('passes with both filled in and contracts left blank', () => {
    const errors = validateExecution({ exit_time: '09:30:00', exit_price: '21010', contracts: '' })
    expect(errors).toEqual({})
  })

  it('rejects a non-numeric exit price', () => {
    const errors = validateExecution({ exit_time: '09:30:00', exit_price: 'abc', contracts: '' })
    expect(errors.exit_price).toBe('Exit price must be a number.')
  })

  it('rejects a zero or negative contracts count, but allows it blank', () => {
    expect(validateExecution({ exit_time: '09:30:00', exit_price: '21010', contracts: '0' }).contracts)
      .toBe('Contracts must be a positive whole number.')
    expect(validateExecution({ exit_time: '09:30:00', exit_price: '21010', contracts: '' }).contracts)
      .toBeUndefined()
  })
})

describe('validateAdditionalExit', () => {
  it('is silent on a row left completely untouched', () => {
    expect(validateAdditionalExit({ exit_time: '', exit_price: '', contracts: '' })).toEqual({})
  })

  it('requires exit time and exit price once any field on the row is filled in', () => {
    const errors = validateAdditionalExit({ exit_time: '', exit_price: '', contracts: '2' })
    expect(errors.exit_time).toBe('Enter the exit time.')
    expect(errors.exit_price).toBe('Enter the exit price.')
  })

  it('passes with exit time and exit price filled in and contracts left blank', () => {
    const errors = validateAdditionalExit({ exit_time: '09:45:00', exit_price: '21015', contracts: '' })
    expect(errors).toEqual({})
  })

  it('rejects a non-numeric exit price on a partially-filled row', () => {
    const errors = validateAdditionalExit({ exit_time: '09:45:00', exit_price: 'abc', contracts: '' })
    expect(errors.exit_price).toBe('Exit price must be a number.')
  })
})
