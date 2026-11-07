import { describe, it, expect } from 'vitest'
import {
  verifiedFactors, unverifiedFactors, hasVerifiedFactor, needsSecondFactor,
  preferredFactor, factorLabel, suggestFactorName, validateFactorName, isLastFactor,
} from './mfaFactors'

// Shaped exactly as Supabase returns them: grouped by type, verified and
// unverified mixed together in the same list.
const f = (over = {}) => ({
  id: 'factor-1', friendly_name: 'Phone', factor_type: 'totp', status: 'verified',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...over,
})
const data = (...totp) => ({ totp, all: totp, phone: [] })

describe('verifiedFactors / unverifiedFactors', () => {
  it('separates a finished enrolment from an abandoned one', () => {
    const d = data(f({ id: 'a' }), f({ id: 'b', status: 'unverified' }))
    expect(verifiedFactors(d).map((x) => x.id)).toEqual(['a'])
    expect(unverifiedFactors(d).map((x) => x.id)).toEqual(['b'])
  })
  it('survives the shapes Supabase actually returns when empty', () => {
    for (const empty of [undefined, null, {}, { totp: [] }, { totp: null }]) {
      expect(verifiedFactors(empty)).toEqual([])
      expect(hasVerifiedFactor(empty)).toBe(false)
    }
  })
  it('ignores a null entry rather than throwing on it', () => {
    expect(verifiedFactors({ totp: [null, f()] })).toHaveLength(1)
  })
})

describe('needsSecondFactor', () => {
  it('challenges a session that could reach aal2 and has not', () => {
    expect(needsSecondFactor({ currentLevel: 'aal1', nextLevel: 'aal2' })).toBe(true)
  })
  // The loop bug: gating on "has a factor" instead of the assurance level
  // re-challenges somebody who just passed, forever.
  it('does NOT re-challenge a session that already reached aal2', () => {
    expect(needsSecondFactor({ currentLevel: 'aal2', nextLevel: 'aal2' })).toBe(false)
  })
  it('does not challenge an account with no factor', () => {
    expect(needsSecondFactor({ currentLevel: 'aal1', nextLevel: 'aal1' })).toBe(false)
  })
  it('does not challenge when the level could not be read', () => {
    expect(needsSecondFactor(null)).toBe(false)
    expect(needsSecondFactor(undefined)).toBe(false)
  })
})

describe('preferredFactor', () => {
  it('is null when there is nothing verified to challenge', () => {
    expect(preferredFactor(data())).toBeNull()
    expect(preferredFactor(data(f({ status: 'unverified' })))).toBeNull()
  })
  it('prefers the most recently used device over the first enrolled', () => {
    const old = f({ id: 'old', created_at: '2026-01-01T00:00:00Z', last_challenged_at: '2026-02-01T00:00:00Z' })
    const recent = f({ id: 'recent', created_at: '2026-06-01T00:00:00Z', last_challenged_at: '2026-10-01T00:00:00Z' })
    expect(preferredFactor(data(old, recent)).id).toBe('recent')
  })
  it('falls back to the oldest enrolment when none has been used', () => {
    const a = f({ id: 'a', created_at: '2026-06-01T00:00:00Z' })
    const b = f({ id: 'b', created_at: '2026-01-01T00:00:00Z' })
    expect(preferredFactor(data(a, b)).id).toBe('b')
  })
  it('never returns an unverified factor even when it is the most recent', () => {
    const verified = f({ id: 'v', last_challenged_at: '2026-01-01T00:00:00Z' })
    const fresh = f({ id: 'u', status: 'unverified', last_challenged_at: '2026-12-01T00:00:00Z' })
    expect(preferredFactor(data(verified, fresh)).id).toBe('v')
  })
})

describe('factorLabel', () => {
  it('uses the name the user gave it', () => {
    expect(factorLabel(f({ friendly_name: 'Work phone' }))).toBe('Work phone')
  })
  // Factors enrolled before names were asked for have no friendly_name.
  // An empty label leaves a Remove button with nothing saying what it
  // removes, which is the one row you must not get wrong.
  it('falls back to the enrolment date rather than an empty string', () => {
    const label = factorLabel(f({ friendly_name: undefined, created_at: '2026-03-04T00:00:00Z' }))
    expect(label).toMatch(/^Authenticator added /)
    expect(label.length).toBeGreaterThan('Authenticator added '.length)
  })
  it('still says something for a factor with no usable date', () => {
    expect(factorLabel({})).toBe('Authenticator app')
    expect(factorLabel(null)).toBe('Authenticator app')
  })
})

describe('suggestFactorName', () => {
  it('uses the plain name when nothing has taken it', () => {
    expect(suggestFactorName(data())).toBe('My phone')
  })
  it('steps past names already in use', () => {
    expect(suggestFactorName(data(f({ friendly_name: 'My phone' })))).toBe('My phone 2')
    expect(suggestFactorName(data(
      f({ friendly_name: 'My phone' }),
      f({ friendly_name: 'My phone 2' }),
    ))).toBe('My phone 3')
  })
  it('counts an unverified factor as taking its name, because the server does', () => {
    expect(suggestFactorName(data(f({ friendly_name: 'My phone', status: 'unverified' }))))
      .toBe('My phone 2')
  })
})

describe('validateFactorName', () => {
  it('accepts a plain new name', () => {
    expect(validateFactorName('iPad', data(f({ friendly_name: 'Phone' })))).toBeNull()
  })
  it('rejects an empty or whitespace name', () => {
    expect(validateFactorName('', data())).toMatch(/name/i)
    expect(validateFactorName('   ', data())).toMatch(/name/i)
    expect(validateFactorName(null, data())).toMatch(/name/i)
  })
  it('rejects a duplicate regardless of case, because Supabase will', () => {
    expect(validateFactorName('phone', data(f({ friendly_name: 'Phone' })))).toMatch(/already have/i)
  })
  it('rejects an absurdly long name before the server does', () => {
    expect(validateFactorName('x'.repeat(61), data())).toMatch(/too long/i)
  })
  it('trims before judging, so " iPad " is not a different device', () => {
    expect(validateFactorName(' iPad ', data(f({ friendly_name: 'iPad' })))).toMatch(/already have/i)
  })
})

describe('isLastFactor', () => {
  // Removing one of three leaves 2FA on; removing the only one turns the
  // protection off. The confirmation has to be able to tell them apart.
  it('is true only for the single remaining verified factor', () => {
    expect(isLastFactor(data(f({ id: 'only' })), 'only')).toBe(true)
  })
  it('is false when another verified factor would survive', () => {
    expect(isLastFactor(data(f({ id: 'a' }), f({ id: 'b' })), 'a')).toBe(false)
  })
  it('ignores unverified factors, which protect nothing', () => {
    const d = data(f({ id: 'a' }), f({ id: 'half', status: 'unverified' }))
    expect(isLastFactor(d, 'a')).toBe(true)
  })
})
