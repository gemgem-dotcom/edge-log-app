import { describe, it, expect } from 'vitest'
import { friendlyStrategyError } from './supabaseErrors'

describe('friendlyStrategyError', () => {
  it('translates a duplicate strategy name into a friendly message', () => {
    const error = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "strategies_instrument_id_name_key"',
    }
    expect(friendlyStrategyError(error)).toBe('You already have a strategy with this name.')
  })

  it('passes through any other error message unchanged', () => {
    const error = { code: '42501', message: 'permission denied for table strategies' }
    expect(friendlyStrategyError(error)).toBe('permission denied for table strategies')
  })

  it('does not match a 23505 on a different constraint', () => {
    const error = { code: '23505', message: 'duplicate key value violates unique constraint "instruments_user_id_symbol_key"' }
    expect(friendlyStrategyError(error)).toBe(error.message)
  })

  it('returns null for no error', () => {
    expect(friendlyStrategyError(null)).toBeNull()
  })
})
