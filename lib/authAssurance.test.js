import { describe, it, expect } from 'vitest'
import {
  decodeJwtClaims, verifiedFactorsOf, sessionNeedsSecondFactor, authMethodsOf,
  isRecoverySession,
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
  // This used to assert false, which encoded the fail-open an
  // adversarial review found: no user and no claims resolved to "let
  // them through". Nothing is known about this caller, and on a gate
  // deciding whether a second factor is owed, nothing known must mean
  // challenge them.
  it('challenges on a completely empty argument rather than throwing', () => {
    expect(() => sessionNeedsSecondFactor({})).not.toThrow()
    expect(sessionNeedsSecondFactor({})).toBe(true)
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

describe('isRecoverySession - the gate on turning 2FA off', () => {
  // Exactly what scripts/probe-recovery-session.js measured against this
  // project's auth server on 2026-11-07. If this test ever fails, the
  // auth server changed and the gate needs re-measuring, not relaxing.
  // iat added when the gate gained a recency bound; the aal and amr
  // values are still exactly what the probe measured.
  const measured = { aal: 'aal1', amr: [{ method: 'otp', timestamp: 1794030562 }], iat: Math.floor(Date.now() / 1000) }

  it('accepts the real recovery session the probe captured', () => {
    expect(isRecoverySession(measured)).toBe(true)
  })
  it('accepts a future auth server that names the method properly', () => {
    expect(isRecoverySession({ aal: 'aal1', amr: ['recovery'], iat: Math.floor(Date.now() / 1000) })).toBe(true)
  })

  // Everything below is a session that must NOT be able to switch off
  // two-factor authentication. These are the whole point of the module.
  it('refuses an ordinary password sign-in', () => {
    expect(isRecoverySession({ aal: 'aal1', amr: [{ method: 'password', timestamp: 1 }], iat: Math.floor(Date.now() / 1000) })).toBe(false)
  })
  it('refuses a Google sign-in', () => {
    expect(isRecoverySession({ aal: 'aal1', amr: ['oauth'], iat: Math.floor(Date.now() / 1000) })).toBe(false)
  })
  // The one that would otherwise slip through: a real signed-in session
  // that happens to also carry an otp method is not a recovery.
  it('refuses a session carrying otp ALONGSIDE another method', () => {
    expect(isRecoverySession({ aal: 'aal1', amr: ['password', 'otp'], iat: Math.floor(Date.now() / 1000) })).toBe(false)
    expect(isRecoverySession({ aal: 'aal1', amr: ['otp', 'password'], iat: Math.floor(Date.now() / 1000) })).toBe(false)
  })
  it('refuses a fully authenticated aal2 session, which belongs in Account settings', () => {
    expect(isRecoverySession({ aal: 'aal2', amr: ['otp'], iat: Math.floor(Date.now() / 1000) })).toBe(false)
    expect(isRecoverySession({ aal: 'aal2', amr: ['password', 'mfa/totp'], iat: Math.floor(Date.now() / 1000) })).toBe(false)
  })
  it('fails closed on anything missing or malformed', () => {
    for (const bad of [null, undefined, {}, { aal: 'aal1' }, { aal: 'aal1', amr: [] }, { amr: ['otp'] }]) {
      expect(isRecoverySession(bad)).toBe(false)
    }
  })
})

describe('sessionNeedsSecondFactor - an account with no 2FA must get in', () => {
  // THE SHAPE THE AUTH SERVER REALLY SENDS for an account with no
  // factors: no `factors` key at all, not an empty list. This block used
  // to assert that shape must be challenged, on the theory that absent
  // meant "unknown" - and every account without 2FA was locked out of
  // the app, looping between /app and /login?step=2fa. The theory was
  // never checked against a real response. This is the response.
  const realNoFactorUser = {
    id: '989eff3e-e5fb-48ba-8455-b1dedf9a0da8',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'new@example.com',
    email_confirmed_at: '2026-11-13T07:04:20Z',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: '2026-11-13T07:03:57Z',
    is_anonymous: false,
  }

  it('lets a brand-new account with no factors field in', () => {
    expect(sessionNeedsSecondFactor({ claims: { aal: 'aal1' }, user: realNoFactorUser })).toBe(false)
  })

  it('reads a missing, null or empty factor list the same way', () => {
    for (const factors of [undefined, null, []]) {
      expect(sessionNeedsSecondFactor({ claims: { aal: 'aal1' }, user: { factors } })).toBe(false)
    }
    expect(sessionNeedsSecondFactor({ claims: { aal: 'aal1' }, user: {} })).toBe(false)
  })

  // The rule must agree with the login form, which uses auth-js's own
  // reading. When the two disagreed, the form sent the user to /app and
  // this gate sent them back, forever.
  it('agrees with auth-js about who needs a second factor', () => {
    const authJsNeedsSecond = (user) => (user.factors ?? []).some((f) => f.status === 'verified')
    for (const user of [realNoFactorUser, { factors: [] }, { factors: [{ status: 'unverified' }] }, { factors: [{ status: 'verified' }] }]) {
      expect(sessionNeedsSecondFactor({ claims: { aal: 'aal1' }, user })).toBe(authJsNeedsSecond(user))
    }
  })

  it('still challenges an account with a verified factor at aal1', () => {
    expect(sessionNeedsSecondFactor({ claims: { aal: 'aal1' }, user: { ...realNoFactorUser, factors: [{ status: 'verified' }] } })).toBe(true)
  })

  // A session with no readable claims has demonstrated nothing, and an
  // account with a factor is still asked for it.
  it('treats missing claims as aal1', () => {
    expect(sessionNeedsSecondFactor({ claims: null, user: { factors: [{ status: 'verified' }] } })).toBe(true)
    expect(sessionNeedsSecondFactor({ claims: null, user: realNoFactorUser })).toBe(false)
  })

  // No user at all is not an account we can vouch for.
  it('challenges when there is no user', () => {
    expect(sessionNeedsSecondFactor({ claims: { aal: 'aal1' }, user: null })).toBe(true)
  })

  it('lets an aal2 session through whatever the list says', () => {
    expect(sessionNeedsSecondFactor({ claims: { aal: 'aal2' }, user: {} })).toBe(false)
    expect(sessionNeedsSecondFactor({ claims: { aal: 'aal2' }, user: { factors: [{ status: 'verified' }] } })).toBe(false)
  })
})

describe('isRecoverySession - the power does not last', () => {
  const nowSec = Math.floor(Date.now() / 1000)
  const recovery = (ageSec) => ({ aal: 'aal1', amr: [{ method: 'otp', timestamp: nowSec - ageSec }], iat: nowSec - ageSec })

  it('accepts one exchanged moments ago', () => {
    expect(isRecoverySession(recovery(5))).toBe(true)
  })
  // Without this, a laptop that once completed a reset keeps a
  // standing 2FA-off switch for the life of its refresh token.
  it('refuses one that is hours old', () => {
    expect(isRecoverySession(recovery(4 * 60 * 60))).toBe(false)
  })
  it('refuses a token with no issued-at to age', () => {
    expect(isRecoverySession({ aal: 'aal1', amr: [{ method: 'otp', timestamp: nowSec }] })).toBe(false)
  })
})
