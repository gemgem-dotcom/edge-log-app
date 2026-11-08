import { describe, it, expect, beforeEach } from 'vitest'
import { peekDashboard, writeDashboard, clearDashboardCache } from './dashboardCache'

const state = (n) => ({ strategies: [], tradesByStrategy: {}, allTrades: [{ id: n }], instrumentId: 'i', regime: null })

beforeEach(() => {
  clearDashboardCache()
})

describe('peekDashboard', () => {
  it('is a miss before anything is written', () => {
    expect(peekDashboard('NQ')).toBeNull()
  })

  it('round-trips per symbol', () => {
    writeDashboard('NQ', state(1))
    writeDashboard('CL', state(2))
    expect(peekDashboard('NQ').allTrades).toEqual([{ id: 1 }])
    expect(peekDashboard('CL').allTrades).toEqual([{ id: 2 }])
  })

  // THE HAZARD this keying exists for: one instrument's strategies and
  // regime shown against another's. The page resets exactly that state on
  // every instrument switch, so a cache that ignored the symbol would
  // reintroduce the bug those resets were added to fix.
  it('never answers for a symbol it was not written for', () => {
    writeDashboard('NQ', state(1))
    expect(peekDashboard('CL')).toBeNull()
    expect(peekDashboard('')).toBeNull()
    expect(peekDashboard(undefined)).toBeNull()
    expect(peekDashboard(null)).toBeNull()
  })
})

describe('writeDashboard', () => {
  it('ignores a missing symbol or state rather than storing a blank', () => {
    writeDashboard(undefined, state(1))
    writeDashboard('NQ', null)
    writeDashboard('NQ', undefined)
    expect(peekDashboard('NQ')).toBeNull()
  })
})

describe('clearDashboardCache', () => {
  it('clears every symbol, which is what sign-out depends on', () => {
    writeDashboard('NQ', state(1))
    writeDashboard('CL', state(2))
    clearDashboardCache()
    expect(peekDashboard('NQ')).toBeNull()
    expect(peekDashboard('CL')).toBeNull()
  })
})
