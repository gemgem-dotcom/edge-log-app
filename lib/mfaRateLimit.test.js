import { describe, it, expect } from 'vitest'
import {
  attemptVerdict, lockoutMessage, remainingWarning,
  isValidKind, MAX_ATTEMPTS, WINDOW_MS,
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
