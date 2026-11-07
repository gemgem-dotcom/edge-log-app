import { describe, it, expect } from 'vitest'
import {
  decodeJwtClaims, verifiedFactorsOf, sessionNeedsSecondFactor, authMethodsOf,
} from './authAssurance'

// Build a token the way Supabase does, so the decoder is exercised
// against real base64url rather than a hand-written string.
const tokenFor = (claims) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.signature-not-checked-here`
}

describe('decodeJwtClaims', () => {
  it('reads the payload of a real-shaped token', () => {
    expect(decodeJwtClaims(tokenFor({ aal: 'aal2', sub: 'u1' }))).toEqual({ aal: 'aal2', sub: 'u1' })
  })
  it('survives base64url padding, which Supabase tokens routinely need', () => {
    for (const sub of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
      expect(decodeJwtClaims(tokenFor({ aal: 'aal1', sub }))?.sub).toBe(sub)
    }
  })
  it('handles non-ASCII in a claim, since emails and names reach these tokens', () => {
    expect(decodeJwtClaims(tokenFor({ email: 'joão@example.com' }))?.email).toBe('joão@example.com')
  })
  // Every one of these must be null rather than a throw: this runs in
  // middleware, and an exception there 500s the page for everyone.
  it('returns null for anything it cannot read, and never throws', () => {
    for (const bad of [null, undefined, '', 'not-a-jwt', 'a.b', 'a.!!!.c', tokenFor('a string, not an object')]) {
      expect(() => decodeJwtClaims(bad)).not.toThrow()
      expect(decodeJwtClaims(bad)).toBeNull()
    }
  })
})

describe('verifiedFactorsOf', () => {
  it('counts only verified factors', () => {
    const user = { factors: [{ status: 'verified' }, { status: 'unverified' }, { status: 'verified' }] }
    expect(verifiedFactorsOf(user)).toHaveLength(2)
  })
  it('is safe on a user with no factors at all', () => {
    expect(verifiedFactorsOf({})).toEqual([])
    expect(verifiedFactorsOf(null)).toEqual([])
  })
})

describe('sessionNeedsSecondFactor', () => {
  const verified = { factors: [{ status: 'verified' }] }

  it('lets an account with no 2FA straight through', () => {
    expect(sessionNeedsSecondFactor({ claims: { aal: 'aal1' }, user: { factors: [] } })).toBe(false)
  })
  it('lets an aal2 session through', () => {
    expect(sessionNeedsSecondFactor({ claims: { aal: 'aal2' }, user: verified })).toBe(false)
  })
  // The hole this whole module exists to close: a password-recovery link
  // mints a live aal1 session without ever showing a code.
  it('stops an aal1 session on an account that has 2FA', () => {
    expect(sessionNeedsSecondFactor({ claims: { aal: 'aal1' }, user: verified })).toBe(true)
  })
  // An abandoned enrolment must not lock someone out of their account
  // over a QR code they never finished scanning.
  it('ignores an unverified factor left behind by an abandoned enrolment', () => {
    expect(sessionNeedsSecondFactor({
      claims: { aal: 'aal1' },
      user: { factors: [{ status: 'unverified' }] },
    })).toBe(false)
  })
  // Fail closed. A session whose assurance cannot be established has not
  // demonstrated any.
  it('treats missing or unreadable claims as aal1', () => {
    expect(sessionNeedsSecondFactor({ claims: null, user: verified })).toBe(true)
    expect(sessionNeedsSecondFactor({ claims: {}, user: verified })).toBe(true)
    expect(sessionNeedsSecondFactor({ claims: { aal: 'nonsense' }, user: verified })).toBe(true)
  })
  it('does not throw on a completely empty argument', () => {
    expect(() => sessionNeedsSecondFactor({})).not.toThrow()
    expect(sessionNeedsSecondFactor({})).toBe(false)
  })
})

describe('authMethodsOf', () => {
  // Supabase emits both shapes and auth-js's types say so, which is why
  // nothing may assume one of them.
  it('reads the object form', () => {
    expect(authMethodsOf({ amr: [{ method: 'password', timestamp: 1 }, { method: 'mfa/totp', timestamp: 2 }] }))
      .toEqual(['password', 'mfa/totp'])
  })
  it('reads the RFC-8176 string form', () => {
    expect(authMethodsOf({ amr: ['otp'] })).toEqual(['otp'])
  })
  it('lowercases, so a comparison cannot miss on case', () => {
    expect(authMethodsOf({ amr: ['OTP'] })).toEqual(['otp'])
  })
  it('returns an empty list rather than throwing on anything else', () => {
    for (const bad of [null, {}, { amr: null }, { amr: 'otp' }, { amr: [null, {}, 5] }]) {
      expect(authMethodsOf(bad)).toEqual([])
    }
  })
})
