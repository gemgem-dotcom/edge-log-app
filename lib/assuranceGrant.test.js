import { describe, it, expect } from 'vitest'
import { sessionIdFrom, grantExpiry, isGrantValid, MAX_GRANT_MS } from './assuranceGrant'

const NOW = Date.parse('2026-11-07T12:00:00Z')
const inDays = (d) => new Date(NOW + d * 86400000).toISOString()

describe('sessionIdFrom', () => {
  it('reads a uuid session id out of the claims', () => {
    const id = '11111111-2222-4333-8444-555555555555'
    expect(sessionIdFrom({ session_id: id })).toBe(id)
  })
  // The value goes into a uuid column and is compared against one in
  // SQL. Anything else must resolve to "no grant" rather than to a
  // query error - the caller then falls back to checking the cookie.
  it('refuses anything that is not a plain uuid', () => {
    for (const bad of [
      undefined, null, '', 'not-a-uuid', 123, {},
      "11111111-2222-4333-8444-555555555555' or '1'='1",
      '11111111-2222-4333-8444-55555555555',
    ]) {
      expect(sessionIdFrom({ session_id: bad })).toBeNull()
    }
    expect(sessionIdFrom(null)).toBeNull()
    expect(sessionIdFrom({})).toBeNull()
  })
})

describe('grantExpiry', () => {
  // A grant must never outlive the trust it came from, so shortening
  // or replacing the device row cannot leave a longer grant behind.
  it('takes the device expiry when it is the shorter of the two', () => {
    expect(grantExpiry(inDays(5), { now: NOW })).toBe(inDays(5))
  })
  it('caps at the maximum when the device outlives it', () => {
    const capped = grantExpiry(inDays(400), { now: NOW })
    expect(Date.parse(capped) - NOW).toBe(MAX_GRANT_MS)
  })
  it('returns null for an unreadable device expiry, so nothing is written', () => {
    expect(grantExpiry(null, { now: NOW })).toBeNull()
    expect(grantExpiry('whenever', { now: NOW })).toBeNull()
  })
  it('produces a grant that is immediately valid', () => {
    expect(isGrantValid({ expires_at: grantExpiry(inDays(3), { now: NOW }) }, { now: NOW })).toBe(true)
  })
})

describe('isGrantValid', () => {
  it('accepts a live grant and refuses an expired one', () => {
    expect(isGrantValid({ expires_at: inDays(1) }, { now: NOW })).toBe(true)
    expect(isGrantValid({ expires_at: inDays(-1) }, { now: NOW })).toBe(false)
  })
  it('refuses one expiring exactly now rather than rounding in the caller\'s favour', () => {
    expect(isGrantValid({ expires_at: new Date(NOW).toISOString() }, { now: NOW })).toBe(false)
  })
  // This decides whether an aal1 session may read rows, so unreadable
  // has to mean no.
  it('fails closed on anything missing or malformed', () => {
    for (const bad of [null, undefined, {}, { expires_at: null }, { expires_at: 'soon' }]) {
      expect(isGrantValid(bad, { now: NOW })).toBe(false)
    }
  })
})
