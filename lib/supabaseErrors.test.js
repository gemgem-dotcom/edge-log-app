import { describe, it, expect } from 'vitest'
import { friendlyStrategyError, friendlyInstrumentError } from './supabaseErrors'

describe('friendlyStrategyError', () => {
  it('translates a duplicate strategy name into a friendly message', () => {
    const error = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "strategies_instrument_id_name_key"',
    }
    expect(friendlyStrategyError(error)).toBe('You already have a strategy with this name.')
  })

  it('falls back to a generic message for any other error', () => {
    const error = { code: '42501', message: 'permission denied for table strategies' }
    expect(friendlyStrategyError(error)).toBe('Something went wrong. Please try again.')
  })

  it('does not match a 23505 on a different constraint', () => {
    const error = { code: '23505', message: 'duplicate key value violates unique constraint "instruments_user_id_symbol_key"' }
    expect(friendlyStrategyError(error)).toBe('Something went wrong. Please try again.')
  })

  it('returns null for no error', () => {
    expect(friendlyStrategyError(null)).toBeNull()
  })
})

describe('friendlyInstrumentError', () => {
  it('translates a duplicate instrument into a friendly message', () => {
    const error = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "instruments_user_id_symbol_key"',
    }
    expect(friendlyInstrumentError(error)).toBe('You already added this instrument.')
  })

  it('falls back to a generic message for any other error', () => {
    const error = { code: '42501', message: 'permission denied for table instruments' }
    expect(friendlyInstrumentError(error)).toBe('Something went wrong. Please try again.')
  })

  it('does not match a 23505 on a different constraint', () => {
    const error = { code: '23505', message: 'duplicate key value violates unique constraint "strategies_instrument_id_name_key"' }
    expect(friendlyInstrumentError(error)).toBe('Something went wrong. Please try again.')
  })

  it('returns null for no error', () => {
    expect(friendlyInstrumentError(null)).toBeNull()
  })
})
