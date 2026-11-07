import { describe, it, expect } from 'vitest'
import {
  attemptVerdict, lockoutMessage, remainingWarning,
  isValidKind, observedSuccess,
  MAX_ATTEMPTS, MAX_ATTEMPTS_ALL_SOURCES, WINDOW_MS, VERIFY_RECENCY_SEC,
} from './mfaRateLimit'

const NOW = Date.parse('2026-11-07T12:00:00Z')
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString()
const fail = (m) => ({ succeeded: false, created_at: minsAgo(m) })
const pass = (m) => ({ succeeded: true, created_at: minsAgo(m) })
const verdict = (rows) => attemptVerdict(rows, { now: NOW })

describe('attemptVerdict - counting', () => {
  it('allows a clean slate', () => {
    const v = verdict([])
    expect(v.allowed).toBe(true)
    expect(v.remaining).toBe(MAX_ATTEMPTS)
  })
  it('counts down as failures accumulate', () => {
    expect(verdict([fail(1)]).remaining).toBe(MAX_ATTEMPTS - 1)
    expect(verdict([fail(1), fail(2), fail(3)]).remaining).toBe(MAX_ATTEMPTS - 3)
  })
  it('locks at exactly the threshold, not before', () => {
    const under = Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => fail(i + 1))
    expect(verdict(under).allowed).toBe(true)
    expect(verdict([...under, fail(MAX_ATTEMPTS)]).allowed).toBe(false)
  })
  it('ignores failures older than the window', () => {
    const stale = Array.from({ length: 10 }, (_, i) => fail(WINDOW_MS / 60000 + i + 1))
    expect(verdict(stale).allowed).toBe(true)
    expect(verdict(stale).failures).toBe(0)
  })
})

describe('attemptVerdict - a success clears the count', () => {
  // The case this exists for: four wrong, then the real owner got in,
  // then one more typo. Without clearing, that account locks out
  // immediately after proving itself.
  it('does not count failures from before a success', () => {
    const rows = [fail(10), fail(9), fail(8), fail(7), pass(6), fail(1)]
    const v = verdict(rows)
    expect(v.allowed).toBe(true)
    expect(v.failures).toBe(1)
  })
  it('still locks on enough failures AFTER the success', () => {
    const rows = [pass(14), ...Array.from({ length: MAX_ATTEMPTS }, (_, i) => fail(i + 1))]
    expect(verdict(rows).allowed).toBe(false)
  })
  it('a success outside the window does not resurrect stale failures', () => {
    const rows = [pass(60), ...Array.from({ length: MAX_ATTEMPTS }, (_, i) => fail(i + 1))]
    expect(verdict(rows).allowed).toBe(false)
  })
})

describe('attemptVerdict - when the lock ends', () => {
  // Measuring from the newest failure would let an attacker hold the
  // lock open forever by continuing to try, punishing only the owner.
  it('ends a window after the OLDEST counted failure, not the newest', () => {
    const rows = [fail(14), fail(13), fail(12), fail(11), fail(0)]
    const v = verdict(rows)
    expect(v.allowed).toBe(false)
    // oldest counted failure was 14 minutes ago, so ~1 minute remains
    expect(Math.round(v.retryAfterMs / 60000)).toBe(1)
  })
  it('cannot be extended by hammering', () => {
    const base = [fail(14), fail(13), fail(12), fail(11), fail(10)]
    const quiet = verdict(base).retryAfterMs
    const hammered = verdict([...base, fail(0.5), fail(0.2), fail(0.1)]).retryAfterMs
    expect(hammered).toBe(quiet)
  })
  it('never reports a negative wait', () => {
    const rows = Array.from({ length: MAX_ATTEMPTS }, () => fail(WINDOW_MS / 60000 - 0.001))
    expect(verdict(rows).retryAfterMs).toBeGreaterThanOrEqual(0)
  })
})

describe('attemptVerdict - malformed input', () => {
  // This runs on the login path. A row with a bad timestamp must not
  // throw, and must not silently count as recent either.
  it('survives nulls, missing fields and unparseable dates', () => {
    const rows = [null, undefined, {}, { succeeded: false, created_at: 'not a date' }, fail(1)]
    expect(() => verdict(rows)).not.toThrow()
    expect(verdict(rows).failures).toBe(1)
  })
  it('is safe on no rows at all', () => {
    expect(attemptVerdict(null, { now: NOW }).allowed).toBe(true)
    expect(attemptVerdict(undefined, { now: NOW }).allowed).toBe(true)
  })
  it('does not assume the rows arrive in any order', () => {
    const ordered = [fail(5), fail(4), fail(3), fail(2), pass(1)]
    const shuffled = [pass(1), fail(3), fail(5), fail(2), fail(4)]
    expect(verdict(ordered)).toEqual(verdict(shuffled))
  })
})

describe('isValidKind', () => {
  it('accepts the kinds the schema documents', () => {
    expect(isValidKind('totp')).toBe(true)
    expect(isValidKind('reauth')).toBe(true)
  })
  // The kind comes off the wire and is written to a column. Anything
  // unrecognised is rejected rather than stored.
  it('rejects anything else, including nothing', () => {
    for (const bad of ['', null, undefined, 'TOTP', 'recovery', 'admin', 1]) {
      expect(isValidKind(bad)).toBe(false)
    }
  })
})

describe('what the user is told', () => {
  // "Try again later" gives someone no way to tell a lockout from a
  // broken app, and a locked-out owner with no recovery codes needs a
  // reason to wait rather than to start resetting their password.
  it('always says when the wait ends', () => {
    expect(lockoutMessage(15 * 60000)).toMatch(/15 minutes/)
    expect(lockoutMessage(60000)).toMatch(/a minute/)
    expect(lockoutMessage(0)).toMatch(/a minute/)
  })
  it('rounds up, so the message is never optimistic', () => {
    expect(lockoutMessage(61000)).toMatch(/2 minutes/)
  })
  it('warns at two left and at one, and not before', () => {
    expect(remainingWarning(3)).toBeNull()
    expect(remainingWarning(2)).toMatch(/2 attempts left/)
    expect(remainingWarning(1)).toMatch(/1 attempt left/)
    expect(remainingWarning(0)).toBeNull()
  })
})

// ---------------------------------------------------------------
// The two findings an adversarial review turned up. Both were real,
// both were exploitable with nothing but the account's password, and
// both are pinned here because the obvious implementation is the
// broken one in each case.
// ---------------------------------------------------------------

describe('observedSuccess - the server decides, not the caller', () => {
  const nowSec = Math.floor(NOW / 1000)
  const mfaAt = (secsAgo) => ({ method: 'mfa/totp', timestamp: nowSec - secsAgo })

  // THE ATTACK THIS CLOSES. /api/mfa-attempt used to read `succeeded`
  // out of the request body. Since a success clears every failure
  // before it, one POST of {"succeeded":true} from a session holding
  // only the password reset the lockout, and the attacker could guess
  // a six-digit code forever while the table recorded only successes.
  it('refuses to call an aal1 session a success, whatever it claims', () => {
    expect(observedSuccess({ aal: 'aal1', amr: [{ method: 'password', timestamp: nowSec }] }, { now: NOW })).toBe(false)
    expect(observedSuccess({ aal: 'aal1', amr: [mfaAt(1)] }, { now: NOW })).toBe(false)
  })

  it('accepts a session that just passed a second factor', () => {
    expect(observedSuccess({ aal: 'aal2', amr: [{ method: 'password', timestamp: nowSec - 5 }, mfaAt(1)] }, { now: NOW })).toBe(true)
  })

  // Without the recency test an already-aal2 user could never record a
  // failure, so the limiter would not apply to enrolment from Account
  // settings at all.
  it('does not count an old second factor as a fresh success', () => {
    expect(observedSuccess({ aal: 'aal2', amr: [mfaAt(VERIFY_RECENCY_SEC + 60)] }, { now: NOW })).toBe(false)
    expect(observedSuccess({ aal: 'aal2', amr: [mfaAt(VERIFY_RECENCY_SEC - 10)] }, { now: NOW })).toBe(true)
  })

  it('accepts any mfa/* method, not just totp', () => {
    expect(observedSuccess({ aal: 'aal2', amr: [{ method: 'mfa/webauthn', timestamp: nowSec }] }, { now: NOW })).toBe(true)
  })

  // Supabase may emit the RFC-8176 plain-string form, which carries no
  // timestamps. The recency test cannot run, so it falls back to the
  // assurance level - weaker, but still unreachable from a
  // password-only session.
  it('falls back to the assurance level when amr carries no timestamps', () => {
    expect(observedSuccess({ aal: 'aal2', amr: ['password', 'mfa/totp'] }, { now: NOW })).toBe(true)
    expect(observedSuccess({ aal: 'aal1', amr: ['password'] }, { now: NOW })).toBe(false)
  })

  it('fails closed on anything missing or malformed', () => {
    for (const bad of [null, undefined, {}, { aal: 'aal2' }, { amr: [mfaAt(1)] }, { aal: 'aal2', amr: 'nope' }]) {
      expect(observedSuccess(bad, { now: NOW })).toBe(!!(bad && bad.aal === 'aal2' && !Array.isArray(bad.amr)))
    }
    expect(observedSuccess(null, { now: NOW })).toBe(false)
    expect(observedSuccess({ aal: 'aal1' }, { now: NOW })).toBe(false)
  })
})

describe('attemptVerdict - the lockout cannot be weaponised against the owner', () => {
  const failFrom = (ip, m) => ({ succeeded: false, created_at: minsAgo(m), ip_hash: ip })
  const OWNER = 'ip-owner'
  const ATTACKER = 'ip-attacker'

  // THE ATTACK THIS CLOSES. Scoped only by user_id, anyone holding the
  // password could spray five failures and lock the real owner out of
  // their own account from any browser. With no recovery codes the
  // owner's only escape is a password reset, which clears their
  // factors - so the DoS was a lever that coerced the victim into
  // removing the protection the attacker could not defeat.
  it('does not lock the owner out because somebody else burned attempts', () => {
    const rows = Array.from({ length: MAX_ATTEMPTS }, (_, i) => failFrom(ATTACKER, i + 1))
    expect(attemptVerdict(rows, { now: NOW, ipHash: ATTACKER }).allowed).toBe(false)
    expect(attemptVerdict(rows, { now: NOW, ipHash: OWNER }).allowed).toBe(true)
    expect(attemptVerdict(rows, { now: NOW, ipHash: OWNER }).remaining).toBe(MAX_ATTEMPTS)
  })

  // Scoping to the IP alone would hand an attacker five fresh guesses
  // per address, so the account-wide cap still has to exist.
  it('still stops a spray spread across many addresses', () => {
    // All inside the 15-minute window - spreading them over 20 minutes
    // ages the oldest out and the cap never fires, which is what the
    // first version of this test got wrong.
    const rows = Array.from({ length: MAX_ATTEMPTS_ALL_SOURCES }, (_, i) => failFrom(`ip-${i}`, (i % 14) + 1))
    const v = attemptVerdict(rows, { now: NOW, ipHash: OWNER })
    expect(v.allowed).toBe(false)
    expect(v.scope).toBe('account')
  })

  it('leaves room below the account-wide cap', () => {
    const rows = Array.from({ length: MAX_ATTEMPTS_ALL_SOURCES - 1 }, (_, i) => failFrom(`ip-${i}`, (i % 14) + 1))
    expect(attemptVerdict(rows, { now: NOW, ipHash: OWNER }).allowed).toBe(true)
  })

  // A success on the owner's laptop must not hand an attacker twenty
  // fresh guesses, so the account-wide count is not cleared by one.
  it('does not let a success elsewhere reset the account-wide cap', () => {
    const rows = [
      ...Array.from({ length: MAX_ATTEMPTS_ALL_SOURCES }, (_, i) => failFrom(`ip-${i}`, (i % 13) + 2)),
      { succeeded: true, created_at: minsAgo(1), ip_hash: OWNER },
    ]
    expect(attemptVerdict(rows, { now: NOW, ipHash: OWNER }).allowed).toBe(false)
  })

  // A request with no usable address counts everything, which is the
  // conservative direction.
  it('falls back to counting every source when there is no address', () => {
    const rows = Array.from({ length: MAX_ATTEMPTS }, (_, i) => failFrom(ATTACKER, i + 1))
    expect(attemptVerdict(rows, { now: NOW, ipHash: null }).allowed).toBe(false)
  })

  it('still behaves as before for a single source', () => {
    const rows = Array.from({ length: MAX_ATTEMPTS }, (_, i) => failFrom(OWNER, i + 1))
    const v = attemptVerdict(rows, { now: NOW, ipHash: OWNER })
    expect(v.allowed).toBe(false)
    expect(v.scope).toBe('caller')
  })
})
