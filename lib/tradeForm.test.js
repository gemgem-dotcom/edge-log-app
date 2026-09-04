import { describe, it, expect } from 'vitest'
import { validateExecution, validateAdditionalExit } from './tradeForm'

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
