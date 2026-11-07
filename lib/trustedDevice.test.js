import { describe, it, expect } from 'vitest'
import {
  isTrustedRowValid, trustExpiresAt, describeTrustedDevice, sortTrustedDevices,
  trustCookieOptions, TRUST_DAYS, TRUST_MS, TRUST_COOKIE,
} from './trustedDevice'

const NOW = Date.parse('2026-11-07T12:00:00Z')
const inDays = (d) => new Date(NOW + d * 86400000).toISOString()
const row = (over = {}) => ({ id: 'r1', user_id: 'u1', label: 'Mac (macOS)', expires_at: inDays(10), ...over })

describe('isTrustedRowValid', () => {
  it('accepts a live row for the right user', () => {
    expect(isTrustedRowValid(row(), { userId: 'u1', now: NOW })).toBe(true)
  })
  // The one that matters most: a token minted for one account must not
  // skip the second factor on another.
  it('refuses a row belonging to a different user', () => {
    expect(isTrustedRowValid(row({ user_id: 'someone-else' }), { userId: 'u1', now: NOW })).toBe(false)
  })
  it('refuses an expired row', () => {
    expect(isTrustedRowValid(row({ expires_at: inDays(-1) }), { userId: 'u1', now: NOW })).toBe(false)
  })
  it('refuses a row expiring exactly now, rather than rounding in the user\'s favour', () => {
    expect(isTrustedRowValid(row({ expires_at: new Date(NOW).toISOString() }), { userId: 'u1', now: NOW })).toBe(false)
  })
  // Fails closed on anything it cannot read. This decides whether to
  // skip a second factor, so "I am not sure" has to mean "no".
  it('refuses anything missing or malformed', () => {
    for (const bad of [null, undefined, {}, { expires_at: null }, { expires_at: 'not a date' }, row({ expires_at: '' })]) {
      expect(isTrustedRowValid(bad, { userId: 'u1', now: NOW })).toBe(false)
    }
  })
})

describe('trustExpiresAt', () => {
  it('is TRUST_DAYS out', () => {
    expect(Date.parse(trustExpiresAt(NOW)) - NOW).toBe(TRUST_MS)
    expect(TRUST_DAYS).toBe(30)
  })
  it('produces a row that is immediately valid', () => {
    expect(isTrustedRowValid(row({ expires_at: trustExpiresAt(NOW) }), { userId: 'u1', now: NOW })).toBe(true)
  })
})

describe('the cookie', () => {
  // Each of these is load-bearing, and each is the kind of thing that
  // gets dropped in a refactor without anything failing visibly.
  it('cannot be read by JavaScript', () => {
    expect(trustCookieOptions().httpOnly).toBe(true)
  })
  it('is not sent over plain http by default', () => {
    expect(trustCookieOptions().secure).toBe(true)
    expect(trustCookieOptions({ secure: false }).secure).toBe(false)
  })
  // Lax, not Strict: Strict would withhold the cookie on a top-level
  // navigation into /app from an external link, and the user would be
  // challenged despite having ticked the box.
  it('is lax so it survives arriving from elsewhere', () => {
    expect(trustCookieOptions().sameSite).toBe('lax')
  })
  it('expires with the row it points at', () => {
    expect(trustCookieOptions().maxAge).toBe(TRUST_MS / 1000)
  })
  it('is not named anything a client-side bundle would pick up', () => {
    expect(TRUST_COOKIE).not.toMatch(/NEXT_PUBLIC/i)
  })
})

describe('describeTrustedDevice', () => {
  it('counts the days left', () => {
    expect(describeTrustedDevice(row({ expires_at: inDays(5) }), { now: NOW }).daysLeft).toBe(5)
    expect(describeTrustedDevice(row({ expires_at: inDays(5) }), { now: NOW }).note).toMatch(/5 more days/)
  })
  it('says day, not days, at one', () => {
    expect(describeTrustedDevice(row({ expires_at: inDays(0.5) }), { now: NOW }).note).toMatch(/1 more day\b/)
  })
  // Shown rather than hidden: a list that quietly drops entries is one
  // people stop trusting, and the row is still in the table.
  it('marks an expired row instead of pretending it is gone', () => {
    const d = describeTrustedDevice(row({ expires_at: inDays(-3) }), { now: NOW })
    expect(d.valid).toBe(false)
    expect(d.note).toMatch(/Expired/)
  })
  it('names an unlabelled row rather than rendering nothing', () => {
    expect(describeTrustedDevice({ expires_at: inDays(1) }, { now: NOW }).label).toBe('Unknown device')
  })
  it('does not throw on junk', () => {
    expect(() => describeTrustedDevice(null, { now: NOW })).not.toThrow()
    expect(describeTrustedDevice(null, { now: NOW }).valid).toBe(false)
  })
})

describe('sortTrustedDevices', () => {
  it('puts the ones still working first', () => {
    const rows = [
      row({ id: 'expired', expires_at: inDays(-1), last_seen_at: inDays(0) }),
      row({ id: 'live', expires_at: inDays(10), last_seen_at: inDays(-5) }),
    ]
    expect(sortTrustedDevices(rows, { now: NOW }).map((r) => r.id)).toEqual(['live', 'expired'])
  })
  it('orders by most recently seen within each group', () => {
    const rows = [
      row({ id: 'old', last_seen_at: inDays(-9) }),
      row({ id: 'recent', last_seen_at: inDays(-1) }),
      row({ id: 'middle', last_seen_at: inDays(-4) }),
    ]
    expect(sortTrustedDevices(rows, { now: NOW }).map((r) => r.id)).toEqual(['recent', 'middle', 'old'])
  })
  it('falls back to created_at when a row has never been seen again', () => {
    const rows = [
      row({ id: 'a', last_seen_at: null, created_at: inDays(-8) }),
      row({ id: 'b', last_seen_at: null, created_at: inDays(-2) }),
    ]
    expect(sortTrustedDevices(rows, { now: NOW }).map((r) => r.id)).toEqual(['b', 'a'])
  })
  it('does not mutate what it is given, and survives junk', () => {
    const rows = [row({ id: 'a' }), null, row({ id: 'b' })]
    const copy = [...rows]
    expect(() => sortTrustedDevices(rows, { now: NOW })).not.toThrow()
    expect(rows).toEqual(copy)
    expect(sortTrustedDevices(null, { now: NOW })).toEqual([])
  })
})
